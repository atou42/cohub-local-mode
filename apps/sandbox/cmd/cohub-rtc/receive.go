package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var outputMu sync.Mutex
var outputBytes atomic.Int64

type receivedPacket struct {
	packet     *rtp.Packet
	receivedAt int64
}

func (s *session) receive(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	var mid string
	for _, transceiver := range s.pc.GetTransceivers() {
		if transceiver.Receiver() == receiver {
			mid = transceiver.Mid()
			break
		}
	}
	s.mu.Lock()
	var owner subscription
	for _, item := range s.remote {
		if item.Mid == mid && mid != "" {
			owner = *item
			break
		}
	}
	s.mu.Unlock()
	if owner.Mid == "" {
		s.fail(errors.New("received an unowned RTC track"))
		return
	}
	s.tasks.Go(func() {
		if err := s.record(track, owner); err != nil && s.ctx.Err() == nil {
			s.fail(err)
		}
	})
}

func (s *session) record(track *webrtc.TrackRemote, owner subscription) (result error) {
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	defer func() { _ = track.SetReadDeadline(time.Now()) }()
	config := s.room.config
	if config.Output == "" {
		return errors.New("received media without an output")
	}
	segment := uuid.NewString()
	var output io.Writer = os.Stdout
	if config.Output != "-" {
		if err := os.MkdirAll(config.Output, 0700); err != nil {
			return err
		}
		path := filepath.Join(config.Output, safeName(owner.ParticipantID)+"-"+safeName(owner.name)+"-"+segment+".rtc")
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		defer file.Close()
		output = file
		s.room.bridge.emit(map[string]any{"kind": "track", "participantId": owner.ParticipantID, "name": owner.name, "segment": segment, "file": path})
	}
	write := func(data []byte, metadata map[string]any) error {
		metadata["version"], metadata["segment"], metadata["participantId"], metadata["name"], metadata["kind"], metadata["bytes"] = 2, segment, owner.ParticipantID, owner.name, owner.kind, len(data)
		header, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		total := outputBytes.Add(int64(4 + len(header) + len(data)))
		if config.MaxBytes > 0 && total > config.MaxBytes {
			return fmt.Errorf("media output reached the %d byte limit", config.MaxBytes)
		}
		prefix := make([]byte, 4+len(header))
		binary.BigEndian.PutUint32(prefix, uint32(len(header)))
		copy(prefix[4:], header)
		outputMu.Lock()
		defer outputMu.Unlock()
		if _, err = output.Write(prefix); err != nil {
			return err
		}
		_, err = output.Write(data)
		return err
	}
	codec := track.Codec()
	var decoded *decoder
	if config.ReceiveFormat == "raw" {
		var err error
		decoded, err = newDecoder(ctx, codec, config, write)
		if err != nil {
			return err
		}
		defer func() {
			if err := decoded.Close(); result == nil {
				result = err
			}
		}()
	}
	packets := make(chan receivedPacket, 256)
	readDone := make(chan error, 1)
	s.tasks.Go(func() {
		defer close(packets)
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				readDone <- err
				return
			}
			received := receivedPacket{packet, time.Now().UnixMicro()}
			select {
			case packets <- received:
			case <-ctx.Done():
				readDone <- ctx.Err()
				return
			default:
				err = errors.New("media output is too slow")
				s.fail(err)
				readDone <- err
				return
			}
		}
	})
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		s.tasks.Go(func() {
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for {
				_ = s.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		})
	}
	for received := range packets {
		packet := received.packet
		if decoded != nil {
			if err := decoded.WriteRTP(packet); err != nil {
				return err
			}
			continue
		}
		raw, err := packet.Marshal()
		if err != nil {
			return err
		}
		if err = write(raw, map[string]any{"format": "rtp", "codec": codec.MimeType, "clockRate": codec.ClockRate, "channels": codec.Channels, "fmtp": codec.SDPFmtpLine, "timestamp": packet.Timestamp, "sequence": packet.SequenceNumber, "marker": packet.Marker, "receivedAt": received.receivedAt}); err != nil {
			return err
		}
	}
	err := <-readDone
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
