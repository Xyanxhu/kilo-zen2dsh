package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testTime() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) }
func zeroCost() *float64  { value := 0.0; return &value }
func paidCost() *float64  { value := 1.5; return &value }

func newReadyStore(models map[string]ModelPrice) *ModelMetadataStore {
	return &ModelMetadataStore{models: models, updatedAt: testTime()}
}

func TestMetadataDecisionPrefersExplicitKiloFreeFlag(t *testing.T) {
	free, paid := true, false
	store := newReadyStore(map[string]ModelPrice{
		"free":          {ID: "free", Free: &free},
		"paid:free":     {ID: "paid:free", Free: &paid, Input: zeroCost(), Output: zeroCost()},
		"zero-fallback": {ID: "zero-fallback", Input: zeroCost(), Output: zeroCost()},
		"costly":        {ID: "costly", Input: paidCost(), Output: paidCost()},
	})
	if got := store.Decide("free"); !got.Allowed || got.Source != "catalog_free" || !got.Known {
		t.Fatalf("explicit Kilo free flag must allow: %+v", got)
	}
	if got := store.Decide("paid:free"); got.Allowed || got.Source != "catalog_free" {
		t.Fatalf("explicit false must win over suffix/pricing fallback: %+v", got)
	}
	if got := store.Decide("zero-fallback"); !got.Allowed {
		t.Fatalf("zero pricing compatibility fallback must allow: %+v", got)
	}
	if got := store.Decide("costly"); got.Allowed || got.Source != "catalog_paid" {
		t.Fatalf("paid record must be denied: %+v", got)
	}
}

func TestMetadataDecisionPendingUsesFreeSuffixOnly(t *testing.T) {
	store := &ModelMetadataStore{models: map[string]ModelPrice{}}
	if got := store.Decide("provider/model:free"); !got.Allowed || got.Source != "name_free_pending" {
		t.Fatalf("pending store must use documented suffix fallback: %+v", got)
	}
	if got := store.Decide("anything"); got.Allowed || got.Source != "catalog_pending" {
		t.Fatalf("pending store must reject non-free names: %+v", got)
	}
}

func TestDecodeKiloPrices(t *testing.T) {
	payload := map[string]any{"data": []any{
		map[string]any{"id": "kilo-auto/free", "isFree": true, "pricing": map[string]any{"prompt": "0", "completion": "0"}},
		map[string]any{"id": "paid", "isFree": false, "pricing": map[string]any{"prompt": "1.5", "completion": 2.0}},
	}}
	data, _ := json.Marshal(payload)
	models, err := decodeKiloPrices(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models["kilo-auto/free"].Free == nil || !*models["kilo-auto/free"].Free {
		t.Fatalf("Kilo free flag not decoded: %+v", models)
	}
	if models["paid"].Input == nil || *models["paid"].Input != 1.5 {
		t.Fatalf("Kilo pricing not decoded: %+v", models["paid"])
	}
}

func TestMetadataCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "agent-config.json")
	path := configPath + ".kilo-models.json"
	free := true
	cache := modelMetadataCache{UpdatedAt: testTime(), Models: map[string]ModelPrice{"a": {ID: "a", Free: &free}}}
	if err := saveMetadataCache(path, cache); err != nil {
		t.Fatal(err)
	}
	store := NewModelMetadataStore(configPath, nil)
	decision := store.Decide("a")
	if !decision.Allowed || decision.Source != "catalog_free" {
		t.Fatalf("cache round trip lost semantics: %+v", decision)
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		t.Fatalf("cache file missing: %v", err)
	}
}
