package process

import (
	"io"
	"log/slog"
	"os"
	"testing"
)

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
