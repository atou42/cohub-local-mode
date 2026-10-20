package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/rtccore"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

type configuration struct {
	Protocol      int    `json:"protocol"`
	ParticipantID string `json:"participantId"`
	Audio         string `json:"audio"`
	Video         string `json:"video"`
	AudioFormat   string `json:"audioFormat"`
	VideoFormat   string `json:"videoFormat"`
	Rate          string `json:"rate"`
	Channels      string `json:"channels"`
	Size          string `json:"size"`
	FPS           string `json:"fps"`
	Output        string `json:"output"`
	ReceiveFormat string `json:"receiveFormat"`
	ReceiveSize   string `json:"receiveSize"`
	Participant   string `json:"participant"`
	Channel       string `json:"channel"`
	Delivery      string `json:"delivery"`
	DataInput     string `json:"dataInput"`
	MaxBytes      int64  `json:"maxBytes"`
}

func (c configuration) validate() error {
	if c.Protocol != 1 {
		return errors.New("RTC helper protocol mismatch")
	}
	if c.Delivery != "reliable" && c.Delivery != "latest" {
		return errors.New("invalid data delivery policy")
	}
	if c.DataInput != "" && c.Channel == "" {
		return errors.New("data input requires a channel")
	}
	stdin := 0
	for _, path := range []string{c.Audio, c.Video, c.DataInput} {
		if path == "-" {
			stdin++
		}
	}
	if stdin > 1 {
		return errors.New("only one input can use stdin")
	}
	if c.AudioFormat != "pcm" && c.AudioFormat != "opus" {
		return errors.New("audio format must be pcm or opus")
	}
	if c.VideoFormat != "i420" && c.VideoFormat != "vp8" {
		return errors.New("video format must be i420 or vp8")
	}
	if c.Audio != "" && c.AudioFormat == "pcm" {
		rate, err := strconv.Atoi(c.Rate)
		if err != nil || rate < 8000 || rate > 192000 {
			return errors.New("audio rate must be 8000..192000")
		}
		if c.Channels != "1" && c.Channels != "2" {
			return errors.New("audio channels must be 1 or 2")
		}
	}
	if c.Video != "" && c.VideoFormat == "i420" {
		var width, height int
		if n, _ := fmt.Sscanf(c.Size, "%dx%d", &width, &height); n != 2 || width < 2 || height < 2 || width > 8192 || height > 8192 || width%2 != 0 || height%2 != 0 || fmt.Sprintf("%dx%d", width, height) != c.Size {
			return errors.New("I420 requires even dimensions up to 8192x8192")
		}
		fps, err := strconv.ParseFloat(c.FPS, 64)
		if err != nil || !(fps > 0 && fps <= 120) {
			return errors.New("fps must be greater than zero and at most 120")
		}
	}
	if (c.Audio != "" && c.AudioFormat == "pcm") || (c.Video != "" && c.VideoFormat == "i420") {
		if _, err := exec.LookPath("ffmpeg"); err != nil {
			return errors.New("raw media input requires ffmpeg on PATH")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		encoders, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-encoders").Output()
		if err != nil {
			return fmt.Errorf("inspect ffmpeg encoders: %w", err)
		}
		if c.Audio != "" && c.AudioFormat == "pcm" && !bytes.Contains(encoders, []byte(" libopus ")) {
			return errors.New("ffmpeg needs the libopus encoder for PCM input")
		}
		if c.Video != "" && c.VideoFormat == "i420" && !bytes.Contains(encoders, []byte(" libvpx ")) {
			return errors.New("ffmpeg needs the libvpx encoder for I420 input")
		}
	}
	if c.ReceiveFormat != "" && c.ReceiveFormat != "rtp" && c.ReceiveFormat != "raw" {
		return errors.New("receive format must be rtp or raw")
	}
	if c.ReceiveFormat == "raw" && c.Output != "" {
		if _, err := exec.LookPath("ffmpeg"); err != nil {
			return errors.New("raw media output requires ffmpeg on PATH")
		}
	}
	if c.MaxBytes < 0 {
		return errors.New("max bytes must be non-negative")
	}
	return nil
}

type source struct {
	ctx           context.Context
	config        configuration
	kind, path    string
	track         *webrtc.TrackLocalStaticRTP
	publicationID string
	transceiver   *webrtc.RTPTransceiver
}

func newSource(ctx context.Context, config configuration, kind, path string) (*source, error) {
	capability := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
	if kind == "video" {
		capability = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}
	}
	track, err := webrtc.NewTrackLocalStaticRTP(capability, kind, "cohub")
	if err != nil {
		return nil, err
	}
	return &source{ctx: ctx, config: config, kind: kind, path: path, track: track}, nil
}
func (s *source) input() (io.ReadCloser, func() error, error) {
	raw := (s.kind == "audio" && s.config.AudioFormat == "pcm") || (s.kind == "video" && s.config.VideoFormat == "i420")
	if !raw {
		file := os.Stdin
		var err error
		if s.path != "-" {
			file, err = os.Open(s.path)
		}
		if err != nil {
			return nil, nil, err
		}
		return file, func() error { return nil }, nil
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if s.kind == "audio" {
		args = append(args, "-f", "s16le", "-ar", s.config.Rate, "-ac", s.config.Channels)
	} else {
		args = append(args, "-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", s.config.Size, "-framerate", s.config.FPS)
	}
	path := s.path
	if path == "-" {
		path = "pipe:0"
	}
	args = append(args, "-i", path)
	if s.kind == "audio" {
		args = append(args, "-vn", "-c:a", "libopus", "-ar", "48000", "-frame_duration", "20", "-page_duration", "20000", "-f", "ogg", "pipe:1")
	} else {
		args = append(args, "-an", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "6", "-lag-in-frames", "0", "-g", "60", "-f", "ivf", "pipe:1")
	}
	command := exec.CommandContext(s.ctx, "ffmpeg", args...)
	if s.path == "-" {
		command.Stdin = os.Stdin
	}
	command.Stderr = os.Stderr
	output, err := command.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err = command.Start(); err != nil {
		output.Close()
		return nil, nil, err
	}
	return output, command.Wait, nil
}
func (s *source) run() error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	s.ctx = ctx
	input, wait, err := s.input()
	if err != nil {
		return err
	}
	stop := context.AfterFunc(s.ctx, func() { _ = input.Close() })
	defer stop()
	defer input.Close()
	var payloader rtp.Payloader = &codecs.OpusPayloader{}
	clock := rtccore.Clock{Rate: 48000}
	if s.kind == "video" {
		payloader = &codecs.VP8Payloader{EnablePictureID: true}
		clock.Rate = 90000
	}
	sequence := rtp.NewRandomSequencer()
	start := time.Now()
	write := func(data []byte, pts uint64) error {
		deadline := start.Add(time.Duration(pts) * time.Microsecond)
		timer := time.NewTimer(max(0, time.Until(deadline)))
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return s.ctx.Err()
		case <-timer.C:
		}
		if time.Since(deadline) > time.Second {
			start = time.Now().Add(-time.Duration(pts) * time.Microsecond)
		}
		timestamp := clock.Timestamp(pts, time.Now())
		payloads := payloader.Payload(1200, data)
		for index, payload := range payloads {
			if err := s.track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence.NextSequenceNumber(), Timestamp: timestamp, Marker: index == len(payloads)-1}, Payload: payload}); err != nil {
				return err
			}
		}
		return nil
	}
	if s.kind == "video" {
		err = readIVF(input, write)
	} else {
		err = readOpus(input, write)
	}
	input.Close()
	if err != nil {
		cancel()
		_ = wait()
		return err
	}
	return wait()
}

func readIVF(input io.Reader, write func([]byte, uint64) error) error {
	header := make([]byte, 32)
	if _, err := io.ReadFull(input, header); err != nil {
		return err
	}
	if string(header[:4]) != "DKIF" || string(header[8:12]) != "VP80" || binary.LittleEndian.Uint16(header[6:8]) != 32 {
		return errors.New("video input must be VP8 IVF")
	}
	denominator, numerator := binary.LittleEndian.Uint32(header[16:20]), binary.LittleEndian.Uint32(header[20:24])
	if denominator == 0 || numerator == 0 {
		return errors.New("invalid IVF timebase")
	}
	var first, last uint64
	started := false
	for {
		if _, err := io.ReadFull(input, header[:12]); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		size := binary.LittleEndian.Uint32(header[:4])
		if size == 0 || size > 16<<20 {
			return errors.New("IVF frame exceeds 16 MiB")
		}
		pts := binary.LittleEndian.Uint64(header[4:12])
		if !started {
			first, last, started = pts, pts, true
		}
		if pts < last || pts-last > uint64(denominator)*60/uint64(numerator) {
			return errors.New("invalid IVF timestamp discontinuity")
		}
		last = pts
		payload := make([]byte, size)
		if _, err := io.ReadFull(input, payload); err != nil {
			return err
		}
		if err := write(payload, (pts-first)*uint64(numerator)*1000000/uint64(denominator)); err != nil {
			return err
		}
	}
}

func readOpus(input io.Reader, write func([]byte, uint64) error) error {
	header := make([]byte, 27)
	var packet []byte
	var samples uint64
	var serial, pageIndex uint32
	var pages uint64
	head := false
	for {
		if _, err := io.ReadFull(input, header); err != nil {
			if err == io.EOF && len(packet) == 0 && head {
				return nil
			}
			return err
		}
		if string(header[:4]) != "OggS" || header[4] != 0 {
			return errors.New("audio input must be Ogg Opus")
		}
		if pages > 0 && (binary.LittleEndian.Uint32(header[14:18]) != serial || binary.LittleEndian.Uint32(header[18:22]) != pageIndex+1) {
			return errors.New("Ogg stream is multiplexed or has missing pages")
		}
		serial, pageIndex = binary.LittleEndian.Uint32(header[14:18]), binary.LittleEndian.Uint32(header[18:22])
		pages++
		if (header[5]&1 != 0) != (len(packet) > 0) {
			return errors.New("invalid Ogg packet continuation")
		}
		lacing := make([]byte, int(header[26]))
		if _, err := io.ReadFull(input, lacing); err != nil {
			return err
		}
		length := 0
		for _, size := range lacing {
			length += int(size)
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(input, payload); err != nil {
			return err
		}
		expected := binary.LittleEndian.Uint32(header[22:26])
		clear(header[22:26])
		var checksum uint32
		for _, part := range [][]byte{header, lacing, payload} {
			for _, value := range part {
				checksum ^= uint32(value) << 24
				for bit := 0; bit < 8; bit++ {
					if checksum&0x80000000 != 0 {
						checksum = checksum<<1 ^ 0x04c11db7
					} else {
						checksum <<= 1
					}
				}
			}
		}
		if checksum != expected {
			return errors.New("Ogg checksum mismatch")
		}
		for _, size := range lacing {
			offset := len(packet)
			if offset+int(size) > 65536 {
				return errors.New("Opus packet exceeds 64 KiB")
			}
			packet = append(packet, payload[:int(size)]...)
			payload = payload[int(size):]
			if size == 255 {
				continue
			}
			if bytes.HasPrefix(packet, []byte("OpusHead")) {
				if head || len(packet) < 19 || packet[9] < 1 || packet[9] > 2 || packet[18] != 0 {
					return errors.New("only single-stream mono/stereo Opus is supported")
				}
				head = true
			} else if !bytes.HasPrefix(packet, []byte("OpusTags")) {
				if !head {
					return errors.New("missing OpusHead")
				}
				count, err := opusSamples(packet)
				if err != nil {
					return err
				}
				if err = write(packet, samples*1000000/48000); err != nil {
					return err
				}
				samples += uint64(count)
			}
			packet = packet[:0]
		}
	}
}
func opusSamples(packet []byte) (int, error) {
	if len(packet) == 0 {
		return 0, errors.New("empty Opus packet")
	}
	toc := packet[0]
	var duration int
	if toc&128 != 0 {
		duration = 120 << ((toc >> 3) & 3)
	} else if toc&96 == 96 {
		duration = 480 << ((toc >> 3) & 1)
	} else {
		duration = []int{480, 960, 1920, 2880}[(toc>>3)&3]
	}
	count := 1
	switch toc & 3 {
	case 1, 2:
		count = 2
	case 3:
		if len(packet) < 2 {
			return 0, errors.New("invalid Opus packet")
		}
		count = int(packet[1] & 63)
	}
	if count == 0 || count*duration > 5760 {
		return 0, errors.New("invalid Opus duration")
	}
	return count * duration, nil
}

func (s *session) sendData() error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	input := os.Stdin
	var err error
	if s.room.config.DataInput != "-" {
		input, err = os.Open(s.room.config.DataInput)
		if err != nil {
			return err
		}
	}
	defer input.Close()
	stop := context.AfterFunc(s.ctx, func() { input.Close() })
	defer stop()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 65537)
	var sequence uint32
	for scanner.Scan() {
		data := bytes.TrimSpace(scanner.Bytes())
		if len(data) == 0 {
			continue
		}
		if len(data) > 65536 || !json.Valid(data) {
			return errors.New("data input must contain JSON messages up to 64 KiB")
		}
		sequence++
		frame := make([]byte, len(data)+5)
		binary.BigEndian.PutUint32(frame[1:5], sequence)
		copy(frame[5:], data)
		timeout := time.NewTimer(15 * time.Second)
		ticker := time.NewTicker(10 * time.Millisecond)
		for s.channel.ReadyState() != webrtc.DataChannelStateOpen || s.channel.BufferedAmount() > 1<<20 {
			select {
			case <-s.ctx.Done():
				timeout.Stop()
				ticker.Stop()
				return s.ctx.Err()
			case <-timeout.C:
				ticker.Stop()
				return errors.New("RTC data channel is backpressured")
			case <-ticker.C:
			}
		}
		timeout.Stop()
		ticker.Stop()
		if err := s.channel.Send(frame); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func safeName(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, value)
}
