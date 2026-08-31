package catalog

// This file keeps the reference project's metadata-store API source
// compatible for downstream users. Kilo normally publishes all information we
// need in /models, so the sidecar does not start this store; when constructed
// explicitly it reads the same Kilo endpoint and never contacts models.dev.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"kilo2dsh/agent/internal/ids"
)

const (
	kiloModelsDefaultURL = "https://api.kilo.ai/api/gateway/models"
	kiloMetadataRefresh  = 24 * time.Hour
	kiloMetadataTimeout  = 30 * time.Second
)

// Deprecated aliases avoid breaking code that used these package constants in
// tests; their values now point at Kilo, not the old models.dev service.
const (
	modelsDevDefaultURL = kiloModelsDefaultURL
	modelsDevRefresh    = kiloMetadataRefresh
	modelsDevTimeout    = kiloMetadataTimeout
)

type ModelPrice struct {
	ID         string   `json:"id"`
	Input      *float64 `json:"input_cost,omitempty"`
	Output     *float64 `json:"output_cost,omitempty"`
	Deprecated bool     `json:"deprecated"`
	Free       *bool    `json:"free,omitempty"`
}

type AnonymousDecision struct {
	Allowed    bool     `json:"allowed"`
	Source     string   `json:"source"`
	Known      bool     `json:"known"`
	Deprecated bool     `json:"deprecated"`
	InputCost  *float64 `json:"input_cost,omitempty"`
	OutputCost *float64 `json:"output_cost,omitempty"`
}

type metadataSnapshot struct {
	Ready       bool       `json:"ready"`
	Models      int        `json:"models"`
	UpdatedAt   *time.Time `json:"updated_at,omitempty"`
	Stale       bool       `json:"stale"`
	LastError   string     `json:"last_error,omitempty"`
	CachePath   string     `json:"-"`
	NextRefresh *time.Time `json:"next_refresh,omitempty"`
}

type modelMetadataCache struct {
	UpdatedAt time.Time             `json:"updated_at"`
	Models    map[string]ModelPrice `json:"models"`
}

type ModelMetadataStore struct {
	mu        sync.RWMutex
	models    map[string]ModelPrice
	updatedAt time.Time
	lastError string
	cachePath string
	endpoint  string
	client    *http.Client
	logger    *slog.Logger
}

func NewModelMetadataStore(configPath string, logger *slog.Logger) *ModelMetadataStore {
	cachePath := ""
	if configPath != "" {
		cachePath = configPath + ".kilo-models.json"
	}
	store := &ModelMetadataStore{
		models: make(map[string]ModelPrice), cachePath: cachePath, endpoint: kiloModelsDefaultURL,
		client: &http.Client{Timeout: kiloMetadataTimeout}, logger: logger,
	}
	if err := store.loadCache(); err != nil && !errors.Is(err, os.ErrNotExist) {
		store.lastError = "load Kilo model cache: " + err.Error()
	}
	return store
}

func (store *ModelMetadataStore) Start(ctx context.Context) {
	go func() {
		store.refreshAndLog(ctx)
		ticker := time.NewTicker(kiloMetadataRefresh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				store.refreshAndLog(ctx)
			}
		}
	}()
}

func (store *ModelMetadataStore) refreshAndLog(ctx context.Context) {
	if err := store.Refresh(ctx); err != nil {
		if store.logger != nil {
			store.logger.Warn("Kilo model catalog refresh failed", "component", "models", "event", "kilo_refresh_failed", "error", err)
		}
		return
	}
	if store.logger != nil {
		store.logger.Info("Kilo model catalog refreshed", "component", "models", "event", "kilo_refreshed", "models", store.snapshot().Models)
	}
}

func (store *ModelMetadataStore) Refresh(ctx context.Context) error {
	data, err := store.fetch(ctx)
	if err != nil {
		return store.recordError(err)
	}
	models, err := decodeKiloPrices(data)
	if err != nil {
		return store.recordError(err)
	}
	now := time.Now().UTC()
	cache := modelMetadataCache{UpdatedAt: now, Models: models}
	if store.cachePath != "" {
		if err := saveMetadataCache(store.cachePath, cache); err != nil {
			return store.recordError(err)
		}
	}
	store.mu.Lock()
	store.models, store.updatedAt, store.lastError = models, now, ""
	store.mu.Unlock()
	return nil
}

func (store *ModelMetadataStore) fetch(ctx context.Context) ([]byte, error) {
	refreshCtx, cancel := context.WithTimeout(ctx, kiloMetadataTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(refreshCtx, http.MethodGet, store.endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", ids.UserAgent())
	resp, err := store.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("Kilo models endpoint returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 32<<20))
}

func (store *ModelMetadataStore) recordError(err error) error {
	store.mu.Lock()
	store.lastError = err.Error()
	store.mu.Unlock()
	return err
}

func (store *ModelMetadataStore) Decide(model string) AnonymousDecision {
	store.mu.RLock()
	price, exists := store.models[model]
	ready := !store.updatedAt.IsZero() && len(store.models) > 0
	store.mu.RUnlock()
	if !ready {
		if isFreeModel(model) {
			return AnonymousDecision{Allowed: true, Source: "name_free_pending", Known: false}
		}
		return AnonymousDecision{Allowed: false, Source: "catalog_pending", Known: false}
	}
	if !exists {
		return AnonymousDecision{Allowed: false, Source: "catalog_missing", Known: false}
	}
	decision := AnonymousDecision{Known: true, Deprecated: price.Deprecated, InputCost: price.Input, OutputCost: price.Output}
	if price.Deprecated {
		decision.Source = "catalog_deprecated"
		return decision
	}
	if price.Free != nil {
		decision.Allowed = *price.Free
		decision.Source = "catalog_free"
		return decision
	}
	if price.Input != nil && price.Output != nil && *price.Input == 0 && *price.Output == 0 {
		decision.Allowed, decision.Source = true, "catalog_free"
		return decision
	}
	decision.Source = "catalog_paid"
	return decision
}

func (store *ModelMetadataStore) Price(model string) (ModelPrice, bool) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	price, ok := store.models[model]
	return price, ok
}

func (store *ModelMetadataStore) snapshot() metadataSnapshot {
	store.mu.RLock()
	defer store.mu.RUnlock()
	snapshot := metadataSnapshot{Ready: !store.updatedAt.IsZero() && len(store.models) > 0, Models: len(store.models), LastError: store.lastError, CachePath: store.cachePath}
	if !store.updatedAt.IsZero() {
		updated := store.updatedAt.UTC()
		next := updated.Add(kiloMetadataRefresh)
		snapshot.UpdatedAt, snapshot.NextRefresh = &updated, &next
		snapshot.Stale = time.Since(updated) > kiloMetadataRefresh
	}
	return snapshot
}

func (store *ModelMetadataStore) loadCache() error {
	if store.cachePath == "" {
		return nil
	}
	file, err := os.Open(store.cachePath)
	if err != nil {
		return err
	}
	defer file.Close()
	var cache modelMetadataCache
	decoder := json.NewDecoder(io.LimitReader(file, 32<<20))
	if err := decoder.Decode(&cache); err != nil {
		return err
	}
	if cache.UpdatedAt.IsZero() || len(cache.Models) == 0 {
		return errors.New("Kilo model cache is empty or missing updated_at")
	}
	store.models, store.updatedAt = cache.Models, cache.UpdatedAt.UTC()
	return nil
}

func decodeKiloPrices(data []byte) (map[string]ModelPrice, error) {
	var payload KiloModelResponse
	if err := json.Unmarshal(data, &payload); err == nil && len(payload.Data) > 0 {
		result := make(map[string]ModelPrice, len(payload.Data))
		for _, model := range payload.Data {
			model.ID = strings.TrimSpace(model.ID)
			if model.ID == "" {
				continue
			}
			input := numberFromMap(model.Pricing, "prompt", "input")
			output := numberFromMap(model.Pricing, "completion", "output")
			free := isFreeKiloModel(model)
			result[model.ID] = ModelPrice{ID: model.ID, Input: input, Output: output, Free: &free}
		}
		if len(result) > 0 {
			return result, nil
		}
	}
	// Accept an old provider-map fixture for source compatibility, but never
	// fetch that service in production.
	var providers map[string]json.RawMessage
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, fmt.Errorf("decode Kilo models: %w", err)
	}
	keys := make([]string, 0, len(providers))
	for key := range providers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		var provider map[string]any
		if json.Unmarshal(providers[key], &provider) != nil {
			continue
		}
		models := ids.MapAt(provider, "models")
		if len(models) == 0 {
			continue
		}
		result := make(map[string]ModelPrice, len(models))
		for id, raw := range models {
			model, _ := raw.(map[string]any)
			modelID := ids.FirstString(ids.StringAt(model, "id"), id)
			cost := ids.MapAt(model, "cost")
			result[modelID] = ModelPrice{ID: modelID, Input: numberPointer(cost, "input"), Output: numberPointer(cost, "output"), Deprecated: metadataDeprecated(model)}
		}
		if len(result) > 0 {
			return result, nil
		}
	}
	return nil, errors.New("Kilo models response contains no model metadata")
}

// decodeModelsDev remains an old symbol used by early plugin ports.
func decodeModelsDev(data []byte) (map[string]ModelPrice, error) { return decodeKiloPrices(data) }

func numberFromMap(values map[string]interface{}, keys ...string) *float64 {
	for _, key := range keys {
		value, ok := values[key]
		if !ok || value == nil {
			continue
		}
		var number float64
		switch typed := value.(type) {
		case float64:
			number = typed
		case float32:
			number = float64(typed)
		case int:
			number = float64(typed)
		case string:
			parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
			if err != nil {
				continue
			}
			number = parsed
		default:
			continue
		}
		return &number
	}
	return nil
}

func numberPointer(object map[string]any, key string) *float64 { return numberFromMap(object, key) }

func metadataDeprecated(model map[string]any) bool {
	if ids.BoolAt(model, "deprecated") {
		return true
	}
	status := strings.ToLower(ids.FirstString(ids.StringAt(model, "status"), ids.StringAt(model, "lifecycle")))
	return status == "deprecated" || status == "retired" || status == "disabled" || model["deprecated_at"] != nil || model["retirement_date"] != nil
}

func saveMetadataCache(path string, cache modelMetadataCache) error {
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".kilo-models-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		backup := path + ".replace"
		_ = os.Remove(backup)
		if _, statErr := os.Stat(path); statErr == nil {
			if err := os.Rename(path, backup); err != nil {
				return err
			}
		}
		if err := os.Rename(tempPath, path); err != nil {
			_ = os.Rename(backup, path)
			return err
		}
		_ = os.Remove(backup)
		return os.Chmod(path, 0600)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}
