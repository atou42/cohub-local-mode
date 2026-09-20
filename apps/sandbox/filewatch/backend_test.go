package filewatch

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScannerSnapshotAndDiff(t *testing.T) {
	root := t.TempDir()
	s := &scannerBackend{root: root, ignored: IgnorePatterns(), done: make(chan struct{})}
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := s.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "pkg", "ignored"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	after, err := s.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got := diffSnapshots(before, after); len(got) != 0 {
		t.Fatalf("ignored changes: %v", got)
	}
	after["file.txt"] = scannerEntry{nodeType: "file", size: 1, mtimeNs: before["file.txt"].mtimeNs + 1}
	if got := diffSnapshots(before, after); len(got) != 1 || got[0].kind != "modify" {
		t.Fatalf("nanosecond change: %v", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	after, err = s.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got := diffSnapshots(before, after); len(got) != 1 || got[0].kind != "delete" {
		t.Fatalf("delete: %v", got)
	}
}

func TestScannerIncompleteSnapshotAndCancellation(t *testing.T) {
	s := &scannerBackend{root: filepath.Join(t.TempDir(), "missing"), done: make(chan struct{})}
	if entries, err := s.snapshot(); err == nil || entries != nil {
		t.Fatal("missing root must not produce an empty successful snapshot")
	}
	s.root = t.TempDir()
	close(s.done)
	if entries, err := s.snapshot(); err == nil || entries != nil {
		t.Fatal("cancelled scan must not publish partial entries")
	}
}

func TestScannerDiffIsBounded(t *testing.T) {
	next := make(map[string]scannerEntry)
	for i := 0; i <= maxBatchSize; i++ {
		next[fmt.Sprint(i)] = scannerEntry{nodeType: "file"}
	}
	got := diffSnapshots(nil, next)
	if len(got) != 1 || !got[0].resync {
		t.Fatalf("expected bounded resync, got %d events", len(got))
	}
}

func TestBackendEventsFilterAndUseCurrentState(t *testing.T) {
	root := t.TempDir()
	w := &Watcher{root: root, ignored: IgnorePatterns(), pending: make(map[string]Change), closed: make(chan struct{})}
	defer w.Close()
	w.handleBackendEvent(backendEvent{path: filepath.Join(root, "node_modules", "pkg"), resync: true})
	if w.resync {
		t.Fatal("ignored rename must not invalidate whole workspace")
	}
	w.handleBackendEvent(backendEvent{})
	if len(w.pending) != 0 || w.resync {
		t.Fatal("empty event must be ignored")
	}
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	w.handleBackendEvent(backendEvent{path: path, kind: "delete"})
	if w.pending["file"].Kind != "modify" {
		t.Fatal("coalesced removal must not delete a recreated file")
	}
	w.handleBackendEvent(backendEvent{path: filepath.Join(root, "gone"), kind: "create"})
	if w.pending["gone"].Kind != "delete" {
		t.Fatal("vanished create must follow current state")
	}
}

func TestScannerWatcherDeliversAbsolutePaths(t *testing.T) {
	t.Setenv(filewatchBackendEnv, "scan")
	batches := make(chan Batch, 16)
	root := t.TempDir()
	watcher, err := Start(root, slog.New(slog.NewTextHandler(io.Discard, nil)), func(b Batch) { batches <- b })
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	waitForResync(t, batches)
	if err := os.WriteFile(filepath.Join(root, "hello"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(8 * time.Second)
	for {
		select {
		case batch := <-batches:
			for _, change := range batch.Changes {
				if change.Path == "hello" && change.Kind == "create" {
					return
				}
			}
		case <-deadline:
			t.Fatal("scanner did not deliver workspace-relative change")
		}
	}
}

func TestWatcherCloseIsIdempotent(t *testing.T) {
	t.Setenv(filewatchBackendEnv, "scan")
	w, err := Start(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)), func(Batch) {})
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	w.RequestResync()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		t.Fatal("closed watcher must not schedule work")
	}
}

func TestInvalidBackendFailsExplicitly(t *testing.T) {
	t.Setenv(filewatchBackendEnv, "invalid")
	if _, err := Start(t.TempDir(), slog.Default(), func(Batch) {}); err == nil {
		t.Fatal("invalid backend accepted")
	}
}
