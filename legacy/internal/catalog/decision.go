// Package catalog contains the Kilo free-lane model and routing helpers. The
// implementation is a trimmed port of the reference gateway's catalog code;
// authenticated key tiers and secondary metadata scraping are not needed.
package catalog

// Free-model classification now lives in models.go, where it can combine
// Kilo's explicit isFree/is_free flag with the documented :free fallback.
// This file remains as a stable package anchor for downstream builds.
