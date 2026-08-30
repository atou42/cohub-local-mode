package rpc

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/cohub/apps/sandbox/env"
)

func localCommandSandboxArgv(cfg env.Config, command string) []string {
	if !cfg.IsLocal() || runtime.GOOS != "darwin" {
		return nil
	}
	configured := append([]string{cfg.WorkspaceDir}, cfg.WritableRoots...)
	configured = append(configured, os.TempDir(), "/private/tmp", "/var/tmp", "/dev")
	seen := map[string]struct{}{}
	roots := []string{}
	for _, value := range configured {
		root := filepath.Clean(value)
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		if _, exists := seen[root]; exists {
			continue
		}
		seen[root] = struct{}{}
		roots = append(roots, root)
	}
	sort.Strings(roots)
	filters := make([]string, 0, len(roots))
	for _, root := range roots {
		filters = append(filters, "(subpath "+strconv.Quote(root)+")")
	}
	profile := "(version 1) (allow default) (deny file-write* (require-not (require-any " +
		strings.Join(filters, " ") + ")))"
	return []string{"/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "-c", command}
}
