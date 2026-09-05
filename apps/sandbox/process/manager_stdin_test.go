package process

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManagerStartClosedStdin(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "read-stdin.sh")
	if err := os.WriteFile(script, []byte("cat\nprintf 'script EOF\\n'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, command, output string
		argv                  []string
	}{
		{name: "cat", argv: []string{"sh", "-c", "cat; printf 'EOF\\n'"}, output: "EOF\n"},
		{name: "script", argv: []string{"sh", script}, output: "script EOF\n"},
		{name: "pipe", command: "printf 'pipe input\\n' | cat", output: "pipe input\n"},
		{name: "heredoc", command: "cat <<'EOF'\nheredoc input\nEOF", output: "heredoc input\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager := NewManager(slog.New(slog.NewTextHandler(io.Discard, nil)))
			started := time.Now()
			_, stdout, stderr, exitCh, err := manager.StartWithOptions("owner-a", StartOptions{
				Command: tc.command, Argv: tc.argv, CWD: root, TimeoutSecs: 2, CloseStdin: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer stdout.Close()
			defer stderr.Close()
			type readResult struct {
				data []byte
				err  error
			}
			stderrDone := make(chan readResult, 1)
			go func() { data, err := io.ReadAll(stderr); stderrDone <- readResult{data, err} }()
			output, err := io.ReadAll(stdout)
			if err != nil {
				t.Fatal(err)
			}
			exit := <-exitCh
			if exit.ExitCode == nil || *exit.ExitCode != 0 || exit.Reason != "exited" {
				t.Fatalf("stdin did not reach EOF normally: %#v", exit)
			}
			if time.Since(started) >= 2*time.Second {
				t.Fatal("process waited for its timeout instead of EOF")
			}
			stderrResult := <-stderrDone
			if stderrResult.err != nil {
				t.Fatal(stderrResult.err)
			}
			if string(output) != tc.output || len(stderrResult.data) != 0 {
				t.Fatalf("stdout = %q, want %q and empty stderr", output, tc.output)
			}
		})
	}
}

func TestManagerRejectsWritesToInitiallyClosedStdin(t *testing.T) {
	manager := NewManager(slog.New(slog.NewTextHandler(io.Discard, nil)))
	processID, stdout, stderr, exitCh, err := manager.StartWithOptions("owner-a", StartOptions{
		Argv: []string{"sh", "-c", "printf ready"}, CWD: t.TempDir(), TimeoutSecs: 2, CloseStdin: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stdout.Close()
	defer stderr.Close()
	// Output remains undrained, keeping the managed process registered while
	// checking rejection even if the short-lived child has already exited.
	written, closed, err := manager.Write(processID, "owner-a", "unexpected", false)
	if written != 0 || !closed || err == nil || err.Error() != "process stdin is closed" {
		t.Fatalf("write = (%d, %v, %v), want closed stdin error", written, closed, err)
	}
	output, err := io.ReadAll(stdout)
	if err != nil || string(output) != "ready" {
		t.Fatalf("stdout = %q, err = %v", output, err)
	}
	exit := <-exitCh
	if exit.ExitCode == nil || *exit.ExitCode != 0 || exit.Reason != "exited" {
		t.Fatalf("unexpected exit: %#v", exit)
	}
}

func TestManagerWritesAndClosesManagedProcessStdin(t *testing.T) {
	manager := NewManager(slog.New(slog.NewTextHandler(io.Discard, nil)))
	processID, stdout, _, exitCh, err := manager.StartWithOptions("owner-a", StartOptions{
		Argv:        []string{"sh", "-c", "cat"},
		CWD:         os.TempDir(),
		TimeoutSecs: 5,
	})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}

	if _, _, err := manager.Write(processID, "owner-b", "forbidden", false); err == nil {
		t.Fatal("expected owner mismatch to reject process stdin write")
	}

	written, closed, err := manager.Write(processID, "owner-a", "hello\n", true)
	if err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	if written != len("hello\n") {
		t.Fatalf("written bytes = %d, want %d", written, len("hello\n"))
	}
	if !closed {
		t.Fatal("stdin should be closed")
	}

	output, err := io.ReadAll(stdout)
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	if string(output) != "hello\n" {
		t.Fatalf("stdout = %q, want %q", string(output), "hello\n")
	}

	exit := <-exitCh
	if exit.ExitCode == nil || *exit.ExitCode != 0 || exit.Reason != "exited" {
		t.Fatalf("unexpected exit: %#v", exit)
	}
}
