package workspace

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
)

func newTestRunner(t *testing.T) *SetupRunner {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := env.Config{Mode: env.ModeListen, SpaceID: "test-space", WorkspaceDir: t.TempDir(), UserCohubDir: t.TempDir(), ModPaths: []string{t.TempDir(), t.TempDir()}}
	return NewSetupRunner(cfg, process.NewManager(logger), logger, nil)
}

func writeScript(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSetupOrderAndProcessScopedDeduplication(t *testing.T) {
	r := newTestRunner(t)
	paths := []string{filepath.Join(r.cfg.UserCohubDir, "setup.sh"), filepath.Join(r.cfg.ModPaths[0], ".cohub/setup.sh"), filepath.Join(r.cfg.ModPaths[1], ".cohub/setup.sh"), filepath.Join(r.cfg.WorkspaceDir, ".cohub/setup.sh")}
	for i, path := range paths {
		writeScript(t, path, "test -f bootstrap-ready || exit 9\nprintf '"+string(rune('a'+i))+"' >> order\n")
	}
	writeScript(t, filepath.Join(r.cfg.WorkspaceDir, "bootstrap-ready"), "ready")
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if result := r.Run(context.Background()); result.Status != "succeeded" || len(result.Steps) != 4 {
				t.Errorf("unexpected setup result: %+v", result)
			}
		})
	}
	wg.Wait()
	order, err := os.ReadFile(filepath.Join(r.cfg.WorkspaceDir, "order"))
	if err != nil || string(order) != "abcd" {
		t.Fatalf("order=%q, err=%v", order, err)
	}
	next := NewSetupRunner(r.cfg, r.processes, r.logger, nil)
	if next.Run(context.Background()).Status != "succeeded" {
		t.Fatal("new instance did not run")
	}
	order, _ = os.ReadFile(filepath.Join(r.cfg.WorkspaceDir, "order"))
	if string(order) != "abcdabcd" {
		t.Fatalf("order=%q", order)
	}
}

func TestLocalSetupNeverTouchesFilesystem(t *testing.T) {
	r := newTestRunner(t)
	r.cfg.Mode = env.ModeLocal
	writeScript(t, filepath.Join(r.cfg.UserCohubDir, "setup.sh"), "touch should-not-exist\n")
	writeScript(t, filepath.Join(r.cfg.WorkspaceDir, ".cohub/setup.sh"), "touch should-not-exist\n")
	if result := r.Run(context.Background()); result.Status != "failed" || result.Ran {
		t.Fatalf("local setup was accepted: %+v", result)
	}
	entries, err := os.ReadDir(r.cfg.WorkspaceDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != ".cohub" {
		t.Fatal("local setup modified the workspace")
	}
}

func TestSetupTimeoutTerminatesChildren(t *testing.T) {
	r := newTestRunner(t)
	r.timeoutSeconds = 1
	writeScript(t, filepath.Join(r.cfg.UserCohubDir, "setup.sh"), "(sleep 2; touch should-not-exist) &\nwait\n")
	result := r.Run(context.Background())
	if result.Status != "failed" || !strings.Contains(result.Error, "timeout") {
		t.Fatalf("timeout not recorded: %+v", result)
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(r.cfg.WorkspaceDir, "should-not-exist")); !os.IsNotExist(err) {
		t.Fatal("child survived timeout")
	}
}
