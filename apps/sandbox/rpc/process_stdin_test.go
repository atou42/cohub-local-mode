package rpc

import (
	"encoding/json"
	"testing"

	"github.com/cohub/apps/sandbox/protocol"
)

func TestProcessStartClosedStdin(t *testing.T) {
	for _, mode := range []string{"command", "argv"} {
		t.Run(mode, func(t *testing.T) {
			d, router := newProcessDispatcher(t, setupProcRoot(t))
			params := map[string]interface{}{"closeStdin": true, "timeoutSecs": 2}
			if mode == "command" {
				params[mode] = "cat; printf 'EOF\\n'"
			} else {
				params[mode] = []string{"sh", "-c", "cat; printf 'EOF\\n'"}
			}
			raw, err := json.Marshal(params)
			if err != nil {
				t.Fatal(err)
			}
			result := d.handleProcessStart(protocol.RPCRequest{
				RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "stdin-test"},
				Method:               "process.start", Params: raw,
			}, "stdin-op", "owner-a")
			if result != nil {
				t.Fatalf("unexpected synchronous result: %#v", result)
			}
			if code := router.waitExitCode(t); code != 0 {
				t.Fatalf("exit = %d, want 0 without waiting for stdin", code)
			}
			router.mu.Lock()
			defer router.mu.Unlock()
			if router.stdout != "EOF\n" || router.stderr != "" {
				t.Fatalf("stdout=%q stderr=%q", router.stdout, router.stderr)
			}
		})
	}
}

func TestProcessStartRejectsInvalidCloseStdin(t *testing.T) {
	d, _ := newProcessDispatcher(t, setupProcRoot(t))
	result := d.handleProcessStart(protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "bad-stdin"},
		Method:               "process.start", Params: json.RawMessage(`{"command":"cat","closeStdin":"true"}`),
	}, "bad-stdin-op", "owner-a")
	failed, ok := result.(protocol.RPCFailed)
	if !ok || failed.Error.Code != "BAD_REQUEST" {
		t.Fatalf("invalid closeStdin must fail before spawning: %#v", result)
	}
	if stats := d.processManager.Stats(); stats.StartedTotal != 0 {
		t.Fatalf("invalid request spawned a process: %#v", stats)
	}
}
