package env

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveSandboxVersion(t *testing.T) {
	t.Run("prefers Cohub version", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", " cohub-sandbox:current ")
		t.Setenv("IMAGE_VERSION", "cohub-sandbox:legacy")
		if got := ResolveSandboxVersion("fallback"); got != "cohub-sandbox:current" {
			t.Fatalf("ResolveSandboxVersion() = %q, want current version", got)
		}
	})

	t.Run("accepts legacy version", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", "")
		t.Setenv("IMAGE_VERSION", " cohub-sandbox:legacy ")
		if got := ResolveSandboxVersion("fallback"); got != "cohub-sandbox:legacy" {
			t.Fatalf("ResolveSandboxVersion() = %q, want legacy version", got)
		}
	})

	t.Run("uses fallback", func(t *testing.T) {
		t.Setenv("COHUB_SANDBOX_VERSION", "")
		t.Setenv("IMAGE_VERSION", "")
		if got := ResolveSandboxVersion("fallback"); got != "fallback" {
			t.Fatalf("ResolveSandboxVersion() = %q, want fallback", got)
		}
	})
}

func TestParseLocalSpaceWritableRoots(t *testing.T) {
	home := t.TempDir()
	allowed := filepath.Join(home, "allowed")
	if err := os.MkdirAll(allowed, 0o755); err != nil {
		t.Fatal(err)
	}
	spaceID := "11111111-1111-4111-8111-111111111111"
	raw, err := json.Marshal(map[string][]string{spaceID: {allowed}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("COHUB_LOCAL_SPACE_WRITABLE_ROOTS_JSON", string(raw))
	roots, err := parseLocalSpaceWritableRoots(spaceID, home)
	if err != nil {
		t.Fatal(err)
	}
	canonicalAllowed, err := filepath.EvalSymlinks(allowed)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0] != canonicalAllowed {
		t.Fatalf("roots = %v, want [%s]", roots, canonicalAllowed)
	}
	other, err := parseLocalSpaceWritableRoots("22222222-2222-4222-8222-222222222222", home)
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Fatalf("other roots = %v, want none", other)
	}

	outOfHome := t.TempDir()
	raw, err = json.Marshal(map[string][]string{spaceID: {outOfHome}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("COHUB_LOCAL_SPACE_WRITABLE_ROOTS_JSON", string(raw))
	if _, err := parseLocalSpaceWritableRoots(spaceID, home); err == nil {
		t.Fatal("expected an out-of-home root to fail")
	}
}
