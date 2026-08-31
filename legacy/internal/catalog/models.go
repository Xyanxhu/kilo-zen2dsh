package catalog

// Kilo model catalog and free-lane routing.  The local sidecar keeps the
// OpenAI-compatible /v1 API for DSH, while the upstream Kilo gateway uses the
// same JSON model shape at /api/gateway/models and /api/gateway/chat/completions.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"kilo2dsh/agent/internal/ids"
)

type Protocol string

const (
	ProtocolChat      Protocol = "chat"
	ProtocolResponses Protocol = "responses"
	ProtocolAnthropic Protocol = "anthropic"
)

type Tier string

const (
	TierKilo Tier = "kilo"
	// TierZen is retained as a source-compatible alias for callers that used
	// the reference project's single anonymous tier. New routes are reported
	// as TierKilo and the alias is never serialized.
	TierZen Tier = TierKilo
)

type ModelRoute struct {
	ID        string
	Tier      Tier
	Protocol  Protocol
	Anonymous bool
}

// CatalogSnapshot feeds /healthz. Zen is retained as a non-serialized legacy
// alias so older integrations compiling against the sidecar remain source-
// compatible.
type CatalogSnapshot struct {
	Kilo      int       `json:"kilo"`
	Total     int       `json:"total"`
	Exposed   int       `json:"exposed"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
	Zen       int       `json:"-"`
}

// KiloModel is the subset of the gateway model record needed to enforce the
// free, text-only, tool-capable lane. Unknown fields are intentionally ignored
// by encoding/json so Kilo can add metadata without breaking the sidecar.
type KiloModel struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	IsFree       *bool                  `json:"isFree"`
	IsFreeSnake  *bool                  `json:"is_free"`
	Deprecated   bool                   `json:"deprecated"`
	Pricing      map[string]interface{} `json:"pricing"`
	Architecture struct {
		OutputModalities []string `json:"output_modalities"`
	} `json:"architecture"`
	SupportedParameters []string `json:"supported_parameters"`
	ContextLength       int      `json:"context_length"`
	MaxCompletionTokens int      `json:"max_completion_tokens"`
}

// ModelCatalog is a single Kilo free-lane catalog. A metadata store may still
// be supplied by old callers, but live Kilo records take precedence and no
// models.dev request is needed for normal operation.
type ModelCatalog struct {
	mu        sync.RWMutex
	models    map[string]KiloModel
	updatedAt time.Time
	metadata  *ModelMetadataStore
}

func NewModelCatalog(metadata *ModelMetadataStore) *ModelCatalog {
	return &ModelCatalog{models: map[string]KiloModel{}, metadata: metadata}
}

// Replace is a compatibility helper for tests and older callers that already
// performed free filtering. IDs supplied here are treated as trusted free
// text/tool models; production refresh uses ReplaceRecords below.
func (c *ModelCatalog) Replace(modelIDs []string) {
	if modelIDs == nil {
		return
	}
	records := make([]KiloModel, 0, len(modelIDs))
	for _, id := range modelIDs {
		if strings.TrimSpace(id) == "" {
			continue
		}
		free := true
		records = append(records, KiloModel{ID: strings.TrimSpace(id), IsFree: &free, SupportedParameters: []string{"tools"}})
	}
	c.ReplaceRecords(records)
}

// ReplaceRecords installs a live Kilo snapshot. Once a snapshot exists it is
// authoritative: delisted or paid records are not kept from the bootstrap list.
func (c *ModelCatalog) ReplaceRecords(records []KiloModel) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.models = make(map[string]KiloModel, len(records))
	for _, model := range records {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		model.ID = id
		model.Name = strings.TrimSpace(model.Name)
		if model.Name == "" {
			model.Name = id
		}
		c.models[id] = model
	}
	c.updatedAt = time.Now().UTC()
}

// Route selects only the anonymous Kilo lane. The local `hasAnonymous` flag
// remains for compatibility with the sidecar configuration invariant.
func (c *ModelCatalog) Route(model string, hasAnonymous bool) (ModelRoute, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	model = strings.TrimSpace(model)
	if !hasAnonymous {
		return ModelRoute{}, fmt.Errorf("model %q is not available in the Kilo free catalog", model)
	}
	decision := c.anonymousDecisionLocked(model)
	if decision.Allowed && (c.pendingLocked() || c.modelAllowedLocked(model)) {
		return ModelRoute{ID: model, Tier: TierKilo, Protocol: ProtocolChat, Anonymous: true}, nil
	}
	return ModelRoute{}, fmt.Errorf("model %q is not available in the Kilo free catalog", model)
}

func (c *ModelCatalog) modelAllowedLocked(model string) bool {
	record, ok := c.models[model]
	return ok && isFreeKiloModel(record) && isTextModel(record) && supportsTools(record)
}

func (c *ModelCatalog) anonymousDecisionLocked(model string) AnonymousDecision {
	if record, ok := c.models[model]; ok {
		if !isFreeKiloModel(record) {
			return AnonymousDecision{Allowed: false, Source: "catalog_paid", Known: true}
		}
		if !isTextModel(record) {
			return AnonymousDecision{Allowed: false, Source: "catalog_output_unsupported", Known: true}
		}
		if !supportsTools(record) {
			return AnonymousDecision{Allowed: false, Source: "catalog_tools_unsupported", Known: true}
		}
		return AnonymousDecision{Allowed: true, Source: "catalog_free", Known: true}
	}
	if c.pendingLocked() {
		if isStaticFreeModel(model) || isFreeModel(model) {
			return AnonymousDecision{Allowed: true, Source: "static_verified", Known: false}
		}
		return AnonymousDecision{Allowed: false, Source: "catalog_pending", Known: false}
	}
	if c.metadata != nil {
		// Compatibility only: a live snapshot remains authoritative above.
		return c.metadata.Decide(model)
	}
	return AnonymousDecision{Allowed: false, Source: "catalog_missing", Known: false}
}

// AnonymousDecision exposes the decision for diagnostics and /v1/models.
func (c *ModelCatalog) AnonymousDecision(model string) AnonymousDecision {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.anonymousDecisionLocked(strings.TrimSpace(model))
}

// List returns free, text-output, tool-capable model IDs. Before the first
// successful refresh it exposes the conservative bootstrap list.
func (c *ModelCatalog) List() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.pendingLocked() {
		return staticFreeList()
	}
	models := make([]string, 0, len(c.models))
	for id, model := range c.models {
		if isFreeKiloModel(model) && isTextModel(model) && supportsTools(model) {
			models = append(models, id)
		}
	}
	sort.Strings(models)
	return models
}

func (c *ModelCatalog) Snapshot() CatalogSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.pendingLocked() {
		return CatalogSnapshot{Kilo: 0, Zen: 0, Total: 0, Exposed: len(staticFreeModels), UpdatedAt: c.updatedAt}
	}
	exposed := 0
	for _, model := range c.models {
		if isFreeKiloModel(model) && isTextModel(model) && supportsTools(model) {
			exposed++
		}
	}
	return CatalogSnapshot{Kilo: len(c.models), Zen: len(c.models), Total: len(c.models), Exposed: exposed, UpdatedAt: c.updatedAt}
}

func (c *ModelCatalog) Supported(model string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.pendingLocked() {
		return isStaticFreeModel(model) || isFreeModel(model)
	}
	return c.modelAllowedLocked(strings.TrimSpace(model))
}

func (c *ModelCatalog) pendingLocked() bool { return len(c.models) == 0 }

func isFreeKiloModel(model KiloModel) bool {
	if model.Deprecated {
		return false
	}
	if model.IsFree != nil {
		return *model.IsFree
	}
	if model.IsFreeSnake != nil {
		return *model.IsFreeSnake
	}
	id := strings.ToLower(strings.TrimSpace(model.ID))
	if id == "kilo-auto/free" || id == "openrouter/free" || strings.HasSuffix(id, ":free") || strings.HasSuffix(id, "-free") {
		return true
	}
	// Some gateway versions only expose zero pricing for the two virtual free
	// routers. Do not infer free access for arbitrary vendor records.
	prompt := model.Pricing["prompt"]
	if prompt == nil {
		prompt = model.Pricing["input"]
	}
	completion := model.Pricing["completion"]
	if completion == nil {
		completion = model.Pricing["output"]
	}
	return isZero(prompt) && isZero(completion) && (strings.HasPrefix(id, "kilo-auto/") || strings.HasPrefix(id, "openrouter/"))
}

func isZero(value interface{}) bool {
	switch number := value.(type) {
	case float64:
		return number == 0
	case float32:
		return number == 0
	case int:
		return number == 0
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
		return err == nil && parsed == 0
	default:
		return false
	}
}

func isFreeModel(model string) bool {
	id := strings.ToLower(strings.TrimSpace(model))
	return id == "kilo-auto/free" || id == "openrouter/free" || strings.HasSuffix(id, ":free") || strings.HasSuffix(id, "-free")
}

func isTextModel(model KiloModel) bool {
	for _, modality := range model.Architecture.OutputModalities {
		if strings.EqualFold(strings.TrimSpace(modality), "image") {
			return false
		}
	}
	return true
}

func supportsTools(model KiloModel) bool {
	if len(model.SupportedParameters) == 0 {
		return true
	}
	for _, parameter := range model.SupportedParameters {
		if strings.EqualFold(strings.TrimSpace(parameter), "tools") {
			return true
		}
	}
	return false
}

// KiloModelResponse is the public gateway response shape.
type KiloModelResponse struct {
	Data []KiloModel `json:"data"`
}

// FetchKiloModels fetches the public Kilo catalog. No Authorization header is
// sent when key is empty (the normal free-tier path); a non-empty key is an
// explicit opt-in for compatible authenticated deployments.
func FetchKiloModels(ctx context.Context, client *http.Client, modelsURL, key string) ([]KiloModel, int, error) {
	endpoint := strings.TrimRight(modelsURL, "/")
	if !strings.HasSuffix(endpoint, "/models") {
		endpoint += "/models"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", ids.UserAgent())
	if strings.TrimSpace(key) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(key))
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, resp.StatusCode, fmt.Errorf("Kilo models endpoint returned HTTP %d", resp.StatusCode)
	}
	var payload KiloModelResponse
	dec := json.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	if err := dec.Decode(&payload); err != nil {
		return nil, resp.StatusCode, err
	}
	seen := make(map[string]bool, len(payload.Data))
	models := make([]KiloModel, 0, len(payload.Data))
	for _, model := range payload.Data {
		model.ID = strings.TrimSpace(model.ID)
		if model.ID == "" || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		model.Name = strings.TrimSpace(model.Name)
		if model.Name == "" {
			model.Name = model.ID
		}
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil, resp.StatusCode, errors.New("Kilo models endpoint returned an empty list")
	}
	return models, resp.StatusCode, nil
}

// FetchModels is kept for the sidecar's older callers; it now targets Kilo's
// /models endpoint and returns IDs from the full records.
func FetchModels(ctx context.Context, client *http.Client, baseURL, key string) ([]string, int, error) {
	models, status, err := FetchKiloModels(ctx, client, baseURL, key)
	if err != nil {
		return nil, status, err
	}
	idsOut := make([]string, 0, len(models))
	for _, model := range models {
		idsOut = append(idsOut, model.ID)
	}
	return idsOut, status, nil
}
