package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type message struct {
	ID     uint64          `json:"id,omitempty"`
	Kind   string          `json:"kind"`
	Method string          `json:"method,omitempty"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body,omitempty"`
	Error  string          `json:"error,omitempty"`
	Code   string          `json:"code,omitempty"`
}

type bridge struct {
	ctx     context.Context
	cancel  context.CancelFunc
	out     chan any
	mu      sync.Mutex
	pending map[uint64]chan message
	next    atomic.Uint64
	members chan []member
	failure chan error
}

func (b *bridge) fail(err error) {
	if err == nil {
		return
	}
	select {
	case b.failure <- err:
	default:
	}
	b.cancel()
}

func (b *bridge) emit(value any) error {
	select {
	case <-b.ctx.Done():
		return b.ctx.Err()
	case b.out <- value:
		return nil
	default:
		err := errors.New("RTC control output is too slow")
		b.fail(err)
		return err
	}
}

func (b *bridge) request(ctx context.Context, method, path string, body any, result any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	id := b.next.Add(1)
	reply := make(chan message, 1)
	b.mu.Lock()
	b.pending[id] = reply
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	if err = b.emit(message{ID: id, Kind: "request", Method: method, Path: path, Body: raw}); err != nil {
		return err
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("RTC signaling timed out")
	case response := <-reply:
		if response.Error != "" {
			return &signalError{response.Code, response.Error}
		}
		if result != nil {
			return json.Unmarshal(response.Body, result)
		}
		return nil
	}
}

type signalError struct{ code, text string }

func (e *signalError) Error() string { return e.text }

func (b *bridge) read(input io.Reader) {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 256<<10)
	for scanner.Scan() {
		var event message
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			b.fail(err)
			return
		}
		switch event.Kind {
		case "response":
			b.mu.Lock()
			reply := b.pending[event.ID]
			b.mu.Unlock()
			if reply != nil {
				select {
				case reply <- event:
				default:
				}
			}
		case "members":
			var members []member
			if err := json.Unmarshal(event.Body, &members); err != nil {
				b.fail(err)
				return
			}
			select {
			case <-b.members:
			default:
			}
			b.members <- members
		case "shutdown":
			b.cancel()
			return
		default:
			b.fail(fmt.Errorf("unknown control message %q", event.Kind))
			return
		}
	}
	if err := scanner.Err(); err != nil {
		b.fail(err)
	} else {
		b.cancel()
	}
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("cohub-rtc protocol 1")
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	input := os.NewFile(3, "control-in")
	output := os.NewFile(4, "control-out")
	if input == nil || output == nil {
		return errors.New("cohub-rtc must be launched by cohub rooms rtc")
	}
	defer input.Close()
	defer output.Close()
	reader := bufio.NewReaderSize(input, 256<<10)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return err
	}
	if len(line) > 256<<10 {
		return errors.New("RTC configuration is too large")
	}
	var config configuration
	if err = json.Unmarshal(line, &config); err != nil {
		return err
	}
	if err = config.validate(); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	b := &bridge{ctx: ctx, cancel: cancel, out: make(chan any, 256), pending: make(map[uint64]chan message), members: make(chan []member, 1), failure: make(chan error, 1)}
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		encoder := json.NewEncoder(output)
		for value := range b.out {
			if err := encoder.Encode(value); err != nil {
				b.fail(err)
				return
			}
		}
	}()
	go b.read(reader)
	room := &room{bridge: b, config: config}
	err = room.run(ctx)
	cancel()
	close(b.out)
	select {
	case <-writerDone:
	case <-time.After(2 * time.Second):
		return errors.New("RTC control output did not drain")
	}
	select {
	case failure := <-b.failure:
		return failure
	default:
	}
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
