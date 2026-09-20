package filewatch

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestIgnorePatternsDeduplicatesDefaultsAndEnv(t *testing.T) {
	t.Setenv("FS_WATCH_IGNORE", "node_modules, .idea ,../bad,/abs/path,,custom/cache,custom/cache")

	items := IgnorePatterns()

	assertContains(t, items, ".git")
	assertContains(t, items, "node_modules")
	assertContains(t, items, ".idea")
	assertContains(t, items, "custom/cache")
	assertNotContains(t, items, "../bad")
	assertNotContains(t, items, "/abs/path")

	counts := map[string]int{}
	for _, item := range items {
		counts[item]++
	}
	if counts["node_modules"] != 1 {
		t.Fatalf("node_modules should only appear once, got %d in %v", counts["node_modules"], items)
	}
	if counts["custom/cache"] != 1 {
		t.Fatalf("custom/cache should only appear once, got %d in %v", counts["custom/cache"], items)
	}
}

func TestIsIgnoredMatchesDirectoryNameAtAnyDepth(t *testing.T) {
	w := &Watcher{ignored: []string{".git", "node_modules", ".cache"}}

	ignored := []string{
		".git/config",
		"packages/app/.git/index",
		"node_modules/pkg/index.js",
		"apps/web/node_modules/pkg/index.js",
		"packages/a/.cache/vite",
	}
	for _, rel := range ignored {
		if !w.isIgnored(rel) {
			t.Fatalf("expected %q to be ignored", rel)
		}
	}

	allowed := []string{
		"src/git/config",
		"src/node_modules_file.js",
		"cache/.gitignore",
	}
	for _, rel := range allowed {
		if w.isIgnored(rel) {
			t.Fatalf("expected %q to be allowed", rel)
		}
	}
}

func TestIsIgnoredSupportsScopedRelativePatterns(t *testing.T) {
	w := &Watcher{ignored: []string{"apps/web/dist", "generated/cache"}}

	ignored := []string{"apps/web/dist", "apps/web/dist/assets/app.js", "generated/cache/file"}
	for _, rel := range ignored {
		if !w.isIgnored(rel) {
			t.Fatalf("expected %q to be ignored", rel)
		}
	}

	allowed := []string{"dist/assets/app.js", "apps/api/dist/app.js", "other/generated/cache/file"}
	for _, rel := range allowed {
		if w.isIgnored(rel) {
			t.Fatalf("expected %q to be allowed", rel)
		}
	}
}

func TestSanitizeIgnorePattern(t *testing.T) {
	cases := map[string]string{
		" .idea ":    ".idea",
		"foo\\bar/":  "foo/bar",
		"":           "",
		"../secrets": "",
		"foo/../bar": "",
		"/absolute":  "",
		"foo\x00bar": "",
	}

	for input, expected := range cases {
		if got := sanitizeIgnorePattern(input); !reflect.DeepEqual(got, expected) {
			t.Fatalf("sanitizeIgnorePattern(%q) = %q, expected %q", input, got, expected)
		}
	}
}

func TestWatcherDiscoversImmediateWritesInNewNestedDirectory(t *testing.T) {
	t.Setenv(filewatchBackendEnv, "fsnotify")
	root := t.TempDir()
	batches := make(chan Batch, 16)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	watcher, err := Start(root, logger, func(batch Batch) {
		batches <- batch
	})
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	t.Cleanup(func() { _ = watcher.Close() })

	waitForResync(t, batches)

	filePath := filepath.Join(root, "aa", "bb", "c.txt")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}
	if err := os.WriteFile(filePath, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}

	want := map[string]bool{
		"aa":          false,
		"aa/bb":       false,
		"aa/bb/c.txt": false,
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case batch := <-batches:
			for _, change := range batch.Changes {
				if _, ok := want[change.Path]; ok && change.Kind == "create" {
					want[change.Path] = true
				}
			}
			complete := true
			for _, found := range want {
				complete = complete && found
			}
			if complete {
				return
			}
		case <-deadline.C:
			t.Fatalf("missing nested create changes: %v", want)
		}
	}
}

func TestDiscoverAndWatchSubtreeReportsExistingDescendants(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "aa", "bb", "c.txt")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error: %v", err)
	}
	if err := os.WriteFile(filePath, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error: %v", err)
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher() error: %v", err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	w := &Watcher{
		root:    root,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		watcher: watcher,
		ignored: IgnorePatterns(),
	}

	got := make([]string, 0, 2)
	w.discoverAndWatchSubtree(filepath.Join(root, "aa"), func(change Change) bool {
		got = append(got, change.Path)
		return true
	})
	want := []string{"aa/bb", "aa/bb/c.txt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("discovered paths = %v, want %v", got, want)
	}
}

func TestDiscoverAndWatchSubtreeStopsEmittingButKeepsDirectoryCoverage(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"aa/one.txt", "aa/bb/two.txt", "aa/bb/cc/three.txt"} {
		fullPath := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatalf("MkdirAll(%q) error: %v", path, err)
		}
		if err := os.WriteFile(fullPath, []byte("content"), 0o644); err != nil {
			t.Fatalf("WriteFile(%q) error: %v", path, err)
		}
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher() error: %v", err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	w := &Watcher{
		root:    root,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		watcher: watcher,
		ignored: IgnorePatterns(),
	}

	emitted := 0
	w.discoverAndWatchSubtree(filepath.Join(root, "aa"), func(Change) bool {
		emitted++
		return false
	})
	if emitted != 1 {
		t.Fatalf("emitted %d changes after sink stopped, want 1", emitted)
	}
	assertContains(t, watcher.WatchList(), filepath.Join(root, "aa", "bb", "cc"))
}

func TestEnqueueFallsBackToResyncOnlyForANewPathPastTheLimit(t *testing.T) {
	w := &Watcher{
		pending: make(map[string]Change),
		handler: func(Batch) {},
		closed:  make(chan struct{}),
	}
	t.Cleanup(func() {
		w.mu.Lock()
		if w.timer != nil {
			w.timer.Stop()
		}
		w.mu.Unlock()
	})

	for i := 0; i < maxBatchSize; i++ {
		if !w.enqueue(Change{Path: filepath.ToSlash(filepath.Join("dir", fmt.Sprintf("%03d", i))), Kind: "create"}) {
			t.Fatalf("enqueue stopped before reaching the %d-change limit", maxBatchSize)
		}
	}
	if !w.enqueue(Change{Path: "dir/000", Kind: "modify"}) {
		t.Fatal("updating a pending path should not trigger resync")
	}
	if w.enqueue(Change{Path: "dir/overflow", Kind: "create"}) {
		t.Fatal("enqueue accepted a new path beyond the batch limit")
	}
	if !w.resync || len(w.pending) != 0 {
		t.Fatalf("overflow state = resync:%v pending:%d, want resync with no pending changes", w.resync, len(w.pending))
	}
}

func TestMergeChangeTracksFinalState(t *testing.T) {
	cases := []struct {
		name string
		a    string
		b    string
		want string
	}{
		{name: "create then modify", a: "create", b: "modify", want: "create"},
		{name: "create then delete", a: "create", b: "delete", want: "delete"},
		{name: "delete then create", a: "delete", b: "create", want: "create"},
		{name: "delete then modify", a: "delete", b: "modify", want: "create"},
		{name: "modify then delete", a: "modify", b: "delete", want: "delete"},
		{name: "modify then modify", a: "modify", b: "modify", want: "modify"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mergeChange(Change{Path: "file", Kind: tc.a}, Change{Path: "file", Kind: tc.b})
			if got.Kind != tc.want {
				t.Fatalf("mergeChange(%q, %q) kind = %q, want %q", tc.a, tc.b, got.Kind, tc.want)
			}
		})
	}
}

func waitForResync(t *testing.T, batches <-chan Batch) {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case batch := <-batches:
			if batch.Resync {
				return
			}
		case <-timer.C:
			t.Fatal("timed out waiting for initial resync")
		}
	}
}

func assertContains(t *testing.T, items []string, want string) {
	t.Helper()
	for _, item := range items {
		if item == want {
			return
		}
	}
	t.Fatalf("expected %q in %v", want, items)
}

func assertNotContains(t *testing.T, items []string, want string) {
	t.Helper()
	for _, item := range items {
		if item == want {
			t.Fatalf("expected %q not to be in %v", want, items)
		}
	}
}
