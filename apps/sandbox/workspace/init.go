package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
)

const setupOutputLimit = 4096
const setupTimeoutSeconds = 300

type SetupRunner struct {
	cfg            env.Config
	processes      *process.Manager
	logger         *slog.Logger
	onUpdate       func(*protocol.SandboxSetupInfo)
	once           sync.Once
	result         protocol.SandboxSetupInfo
	timeoutSeconds int
}

func NewSetupRunner(cfg env.Config, processes *process.Manager, logger *slog.Logger, onUpdate func(*protocol.SandboxSetupInfo)) *SetupRunner {
	return &SetupRunner{cfg: cfg, processes: processes, logger: logger, onUpdate: onUpdate, timeoutSeconds: setupTimeoutSeconds}
}

func (r *SetupRunner) Run(ctx context.Context) *protocol.SandboxSetupInfo {
	r.once.Do(func() {
		r.result = protocol.SandboxSetupInfo{Status: "running", RunID: uuid.NewString()}
		started := time.Now()
		if r.cfg.IsLocal() {
			r.fail(fmt.Errorf("setup is disabled for local sandboxes"))
			return
		}
		if err := r.run(ctx); err != nil {
			r.fail(err)
		} else {
			r.result.Status = "succeeded"
		}
		r.result.Duration = time.Since(started).Truncate(time.Millisecond).String()
		r.publish()
	})
	return r.snapshot()
}

func (r *SetupRunner) fail(err error) {
	r.result.Status = "failed"
	r.result.Error = err.Error()
	if r.result.ExitCode == 0 {
		r.result.ExitCode = -1
	}
}

func (r *SetupRunner) snapshot() *protocol.SandboxSetupInfo {
	copy := r.result
	copy.Steps = append([]protocol.SandboxSetupStep(nil), r.result.Steps...)
	return &copy
}

func (r *SetupRunner) publish() {
	if r.onUpdate != nil {
		r.onUpdate(r.snapshot())
	}
}

func (r *SetupRunner) run(ctx context.Context) error {
	root, err := os.OpenRoot(r.cfg.WorkspaceDir)
	if err != nil {
		return fmt.Errorf("open workspace: %w", err)
	}
	defer root.Close()
	type source struct{ root, script string }
	sources := []source{{r.cfg.UserCohubDir, "setup.sh"}}
	for _, path := range r.cfg.ModPaths {
		sources = append(sources, source{path, ".cohub/setup.sh"})
	}
	sources = append(sources, source{r.cfg.WorkspaceDir, ".cohub/setup.sh"})
	if len(sources) > 128 {
		return fmt.Errorf("too many setup sources")
	}

	for _, src := range sources {
		if err := ctx.Err(); err != nil {
			return err
		}
		path := filepath.Join(src.root, src.script)
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("stat setup script %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("setup script is not a regular file: %s", path)
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return err
		}
		resolvedRoot, err := filepath.EvalSymlinks(src.root)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(resolvedRoot, resolved)
		if err != nil || !filepath.IsLocal(rel) {
			return fmt.Errorf("setup script escapes its source: %s", path)
		}

		logDir := filepath.Join(".cohub/system/setup", r.result.RunID, fmt.Sprintf("%03d", len(r.result.Steps)+1))
		if err := root.MkdirAll(logDir, 0o700); err != nil {
			return fmt.Errorf("create setup logs: %w", err)
		}
		logs, err := root.OpenRoot(logDir)
		if err != nil {
			return err
		}
		step := protocol.SandboxSetupStep{Path: path, Status: "running", LogDir: logDir}
		r.result.Ran = true
		r.result.Steps = append(r.result.Steps, step)
		r.publish()
		step = r.runScript(ctx, step, logs)
		manifest, marshalErr := json.MarshalIndent(step, "", "  ")
		if marshalErr == nil {
			marshalErr = logs.WriteFile("result.json", manifest, 0o600)
		}
		logs.Close()
		if marshalErr != nil {
			step.Status, step.Error = "failed", fmt.Sprintf("persist setup result: %v", marshalErr)
		}
		r.result.Steps[len(r.result.Steps)-1] = step
		r.result.Stdout, r.result.Stderr, r.result.ExitCode = step.Stdout, step.Stderr, step.ExitCode
		if step.Status == "failed" {
			return fmt.Errorf("setup failed at %s: %s", path, step.Error)
		}
		r.publish()
	}
	return nil
}

func (r *SetupRunner) runScript(ctx context.Context, step protocol.SandboxSetupStep, logs *os.Root) protocol.SandboxSetupStep {
	started := time.Now()
	defer func() { r.logger.Info("setup script finished", slog.String("path", step.Path)) }()
	stdoutLog, err := logs.OpenFile("stdout.log", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		step.Status, step.Error = "failed", err.Error()
		return step
	}
	defer stdoutLog.Close()
	stderrLog, err := logs.OpenFile("stderr.log", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		step.Status, step.Error = "failed", err.Error()
		return step
	}
	defer stderrLog.Close()

	id, stdout, stderr, exit, err := r.processes.StartWithOptions("workspace-setup", process.StartOptions{
		Argv: []string{"bash", step.Path}, CWD: r.cfg.WorkspaceDir, TimeoutSecs: r.timeoutSeconds,
		Env: map[string]string{"WORKSPACE_DIR": r.cfg.WorkspaceDir, "PLATFORM_AGENTS_DIR": r.cfg.PlatformAgentsDir, "USER_AGENTS_DIR": r.cfg.UserAgentsDir, "COHUB_SPACE_ID": r.cfg.SpaceID, "COHUB_SETUP_DIR": filepath.Dir(step.Path)},
	})
	if err != nil {
		step.Status, step.Error = "failed", err.Error()
		return step
	}
	defer stdout.Close()
	defer stderr.Close()
	stopCancel := context.AfterFunc(ctx, func() { _ = r.processes.Abort(id) })
	defer stopCancel()
	var out, errOut previewWriter
	var wg sync.WaitGroup
	var stdoutErr, stderrErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, stdoutErr = io.Copy(io.MultiWriter(stdoutLog, &out), stdout)
		if stdoutErr != nil {
			_ = stdout.Close()
			_ = r.processes.Abort(id)
		}
	}()
	go func() {
		defer wg.Done()
		_, stderrErr = io.Copy(io.MultiWriter(stderrLog, &errOut), stderr)
		if stderrErr != nil {
			_ = stderr.Close()
			_ = r.processes.Abort(id)
		}
	}()
	result := <-exit
	wg.Wait()
	step.Stdout, step.Stderr = out.String(), errOut.String()
	step.Duration = time.Since(started).Truncate(time.Millisecond).String()
	step.ExitCode = -1
	if result.ExitCode != nil {
		step.ExitCode = *result.ExitCode
	}
	step.Status = "succeeded"
	err = errors.Join(stdoutErr, stderrErr, stdoutLog.Sync(), stderrLog.Sync(), ctx.Err())
	if err != nil {
		step.Error = err.Error()
	} else if result.Reason != "exited" {
		step.Error = "setup process " + result.Reason
	} else if result.OutputTruncated {
		step.Error = "setup left open output streams; long-running services are not supported"
	} else if step.ExitCode != 0 {
		step.Error = fmt.Sprintf("exit code %d", step.ExitCode)
	}
	if step.Error != "" {
		step.Status = "failed"
	}
	return step
}

type previewWriter struct {
	data      []byte
	truncated bool
}

func (w *previewWriter) Write(p []byte) (int, error) {
	n := min(len(p), setupOutputLimit-len(w.data))
	w.data = append(w.data, p[:n]...)
	w.truncated = w.truncated || n < len(p)
	return len(p), nil
}
func (w *previewWriter) String() string {
	value := strings.ToValidUTF8(string(w.data), "�")
	if w.truncated {
		value += "...[truncated]"
	}
	return value
}
