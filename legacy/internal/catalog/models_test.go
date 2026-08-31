package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func boolPtr(value bool) *bool { return &value }

func TestCatalogPendingFallsBackToKiloStatic(t *testing.T) {
	original := staticFreeModels
	defer func() { staticFreeModels = original }()
	staticFreeModels = []string{"kilo-auto/free", "stepfun/test:free"}

	modelCatalog := NewModelCatalog(nil)
	if got := modelCatalog.List(); !reflect.DeepEqual(got, staticFreeModels) {
		t.Fatalf("pending catalog must expose Kilo static list, got %v", got)
	}
	if !modelCatalog.Supported("kilo-auto/free") || modelCatalog.Supported("anything-paid") {
		t.Fatalf("pending catalog must allow only free fallback IDs")
	}
	if _, err := modelCatalog.Route("kilo-auto/free", true); err != nil {
		t.Fatalf("static free model must route while pending: %v", err)
	}
}

func TestCatalogDynamicListFiltersKiloCapabilities(t *testing.T) {
	modelCatalog := NewModelCatalog(nil)
	modelCatalog.ReplaceRecords([]KiloModel{
		{ID: "free-a", IsFree: boolPtr(true), SupportedParameters: []string{"tools"}},
		{ID: "suffix:free", SupportedParameters: []string{"tools"}},
		{ID: "paid", IsFree: boolPtr(false), SupportedParameters: []string{"tools"}},
		{ID: "no-tools", IsFree: boolPtr(true), SupportedParameters: []string{"reasoning"}},
		{ID: "image-free", IsFree: boolPtr(true), SupportedParameters: []string{"tools"}, Architecture: struct {
			OutputModalities []string `json:"output_modalities"`
		}{OutputModalities: []string{"image"}}},
	})
	if got := modelCatalog.List(); !reflect.DeepEqual(got, []string{"free-a", "suffix:free"}) {
		t.Fatalf("dynamic catalog must expose only free text/tool models, got %v", got)
	}
	if modelCatalog.Supported("paid") || modelCatalog.Supported("no-tools") || modelCatalog.Supported("image-free") {
		t.Fatalf("paid/unsupported records must not route")
	}
	snap := modelCatalog.Snapshot()
	if snap.Kilo != 5 || snap.Total != 5 || snap.Exposed != 2 || snap.UpdatedAt.IsZero() {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
	if route, err := modelCatalog.Route("free-a", true); err != nil || route.Tier != TierKilo || !route.Anonymous {
		t.Fatalf("free record should route through Kilo: %+v %v", route, err)
	}
}

func TestKiloFreeFlagPrecedenceAndPricingFallback(t *testing.T) {
	modelCatalog := NewModelCatalog(nil)
	modelCatalog.ReplaceRecords([]KiloModel{
		{ID: "camel-false:free", IsFree: boolPtr(false), IsFreeSnake: boolPtr(true), SupportedParameters: []string{"tools"}},
		{ID: "snake-true", IsFreeSnake: boolPtr(true), SupportedParameters: []string{"tools"}},
		{ID: "kilo-auto/custom", Pricing: map[string]interface{}{"input": "0", "output": "0"}, SupportedParameters: []string{"tools"}},
		{ID: "deprecated:free", IsFree: boolPtr(true), Deprecated: true, SupportedParameters: []string{"tools"}},
	})
	if modelCatalog.Supported("camel-false:free") {
		t.Fatal("camelCase isFree=false must override snake_case and suffix")
	}
	if !modelCatalog.Supported("snake-true") || !modelCatalog.Supported("kilo-auto/custom") {
		t.Fatal("snake_case free flag and router zero pricing should be accepted")
	}
	if modelCatalog.Supported("deprecated:free") {
		t.Fatal("deprecated records must not be exposed")
	}
}

func TestFetchKiloModelsIsKeylessByDefault(t *testing.T) {
	var seenPath string
	var seenAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"kilo-auto/free","isFree":true,"supported_parameters":["tools"]},{"id":"paid","isFree":false}]}`))
	}))
	defer server.Close()
	models, status, err := FetchKiloModels(context.Background(), server.Client(), server.URL+"/api/gateway", "")
	if err != nil || status != http.StatusOK {
		t.Fatalf("FetchKiloModels failed: %v %d", err, status)
	}
	if seenPath != "/api/gateway/models" || seenAuth != "" {
		t.Fatalf("keyless Kilo discovery must use /models without auth: path=%s auth=%q", seenPath, seenAuth)
	}
	if len(models) != 2 || models[0].ID != "kilo-auto/free" {
		t.Fatalf("unexpected Kilo records: %+v", models)
	}
}

func TestFetchKiloModelsUsesExplicitTokenOnlyWhenProvided(t *testing.T) {
	var seenAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"id":"kilo-auto/free"}]}`))
	}))
	defer server.Close()
	if _, _, err := FetchKiloModels(context.Background(), server.Client(), server.URL+"/models", "account-token"); err != nil {
		t.Fatal(err)
	}
	if seenAuth != "Bearer account-token" {
		t.Fatalf("explicit token was not forwarded: %q", seenAuth)
	}
}

func TestFetchModelsRejectsEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	if _, _, err := FetchModels(context.Background(), server.Client(), server.URL, ""); err == nil || !strings.Contains(err.Error(), "empty list") {
		t.Fatalf("empty Kilo model list must error, got %v", err)
	}
}
