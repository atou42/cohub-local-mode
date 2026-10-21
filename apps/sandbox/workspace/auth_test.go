package workspace

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
)

func TestSetupDoesNotInheritSandboxCredentials(t *testing.T) {
	t.Setenv("COHUB_SPACE_ID", "test-space")
	t.Setenv("WORKSPACE_DIR", t.TempDir())
	t.Setenv("USER_COHUB_DIR", t.TempDir())
	t.Setenv("SANDBOX_RPC_TOKEN", "test-rpc-token")
	t.Setenv("SANDBOX_REPORT_TOKEN", "test-report-token")
	script := "printf '%s:%s' \"${SANDBOX_RPC_TOKEN-unset}\" \"${SANDBOX_REPORT_TOKEN-unset}\"\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("USER_COHUB_DIR"), "setup.sh"), []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := env.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SandboxRPCToken != "test-rpc-token" || cfg.SandboxReportToken != "test-report-token" {
		t.Fatal("credentials were not retained in Config")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	result := NewSetupRunner(cfg, process.NewManager(logger), logger, nil).Run(context.Background())
	if result.Status != "succeeded" || result.Stdout != "unset:unset" {
		t.Fatal("setup.sh inherited sandbox credentials")
	}
}
