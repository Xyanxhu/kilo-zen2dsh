package catalog

// staticFreeModels is a small bootstrap list used only when Kilo's public
// /models request is temporarily unavailable. The live Kilo response is
// authoritative once it has been received; keep only stable virtual routes
// here because partner model IDs can disappear without notice.
var staticFreeModels = []string{
	"kilo-auto/free",
	"openrouter/free",
}

// Keep this empty until a model has been observed in Kilo's live response and
// passed the same free/tool/text checks as the active list.
var staticFreeCandidates = []string{}

func isStaticFreeModel(model string) bool {
	for _, id := range staticFreeModels {
		if id == model {
			return true
		}
	}
	return false
}

func staticFreeList() []string {
	out := make([]string, 0, len(staticFreeModels))
	out = append(out, staticFreeModels...)
	return out
}

// SetStaticFreeModelsForTesting replaces the active S3 list. It exists so
// cross-package tests (gateway) can pin the static list; production code must
// never call it.
func SetStaticFreeModelsForTesting(ids []string) {
	staticFreeModels = append([]string(nil), ids...)
}
