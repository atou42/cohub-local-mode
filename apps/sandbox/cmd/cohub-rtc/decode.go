package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/h264writer"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type packetWriter interface {
	WriteRTP(*rtp.Packet) error
	Close() error
}
type decoder struct {
	writer     packetWriter
	input      io.WriteCloser
	cancel     context.CancelFunc
	done       chan error
	timestamp  uint32
	frameBytes int
}

func newDecoder(ctx context.Context, codec webrtc.RTPCodecParameters, config configuration, write func([]byte, map[string]any) error) (*decoder, error) {
	ctx, cancel := context.WithCancel(ctx)
	format := "ivf"
	audio := strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus)
	if audio {
		format = "ogg"
	} else if strings.EqualFold(codec.MimeType, webrtc.MimeTypeH264) {
		format = "h264"
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-probesize", "32768", "-analyzeduration", "0", "-f", format, "-i", "pipe:0"}
	frameBytes := 480 * 2 * 2
	metadata := map[string]any{"format": "s16le", "sampleRate": 48000, "channels": 2}
	if audio {
		args = append(args, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1")
	} else {
		var width, height int
		if n, _ := fmt.Sscanf(config.ReceiveSize, "%dx%d", &width, &height); n != 2 || width < 2 || height < 2 || width > 8192 || height > 8192 || width%2 != 0 || height%2 != 0 {
			cancel()
			return nil, errors.New("invalid receive size")
		}
		frameBytes = width * height * 3 / 2
		metadata = map[string]any{"format": "i420", "width": width, "height": height}
		args = append(args, "-an", "-vf", fmt.Sprintf("scale=%d:%d", width, height), "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1")
	}
	command := exec.CommandContext(ctx, "ffmpeg", args...)
	command.Stderr = os.Stderr
	input, err := command.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	if err = command.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, err
	}
	d := &decoder{input: input, cancel: cancel, done: make(chan error, 1)}
	go func() {
		buffer := make([]byte, frameBytes)
		var failure error
		for {
			n, err := io.ReadFull(output, buffer)
			if n > 0 {
				metadata["timestamp"] = time.Now().UnixMicro()
				if err := write(buffer[:n], metadata); err != nil {
					failure = err
					cancel()
					break
				}
			}
			if err != nil {
				if err != io.EOF && err != io.ErrUnexpectedEOF {
					failure = err
				}
				break
			}
		}
		if err := command.Wait(); failure == nil {
			failure = err
		}
		d.done <- failure
	}()
	switch {
	case audio:
		d.writer, err = oggwriter.NewWith(input, codec.ClockRate, codec.Channels)
	case format == "h264":
		d.writer = h264writer.NewWith(input)
	default:
		d.writer, err = ivfwriter.NewWith(struct{ io.Writer }{input}, ivfwriter.WithCodec(codec.MimeType), ivfwriter.WithDirectPTS(), ivfwriter.WithFrameRate(1, codec.ClockRate))
	}
	if err != nil {
		input.Close()
		cancel()
		<-d.done
		return nil, err
	}
	return d, nil
}
func (d *decoder) WriteRTP(packet *rtp.Packet) error {
	if packet.Timestamp != d.timestamp {
		d.timestamp = packet.Timestamp
		d.frameBytes = 0
	}
	d.frameBytes += len(packet.Payload)
	if d.frameBytes > 16<<20 {
		return errors.New("encoded frame exceeds 16 MiB")
	}
	return d.writer.WriteRTP(packet)
}
func (d *decoder) Close() error {
	err := d.writer.Close()
	d.input.Close()
	select {
	case result := <-d.done:
		d.cancel()
		if err != nil {
			return err
		}
		return result
	case <-time.After(2 * time.Second):
		d.cancel()
		<-d.done
		return errors.New("media decoder did not drain")
	}
}
