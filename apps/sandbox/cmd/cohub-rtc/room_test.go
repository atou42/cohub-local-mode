package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/rtccore"
	"github.com/pion/webrtc/v4"
)

func TestRoomMediaAndData(t *testing.T) {
	for _, format := range []string{"rtp", "raw"} {
		t.Run(format, func(t *testing.T) { testRoomMediaAndData(t, format) })
	}
}

func testRoomMediaAndData(t *testing.T, format string) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	audio := filepath.Join(dir, "audio.pcm")
	video := filepath.Join(dir, "video.i420")
	data := filepath.Join(dir, "data.ndjson")
	for path, content := range map[string][]byte{audio: make([]byte, 48000*2), video: make([]byte, 64*64*3/2*30), data: []byte("{\"hello\":\"room\"}\n")} {
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	config := configuration{Protocol: 1, ParticipantID: "self", Audio: audio, Video: video, AudioFormat: "pcm", VideoFormat: "i420", Rate: "48000", Channels: "1", Size: "64x64", FPS: "30", Output: filepath.Join(dir, "received"), Channel: "chat", Delivery: "reliable", DataInput: data, MaxBytes: 1 << 20}
	config.ReceiveFormat, config.ReceiveSize = format, "64x64"
	if err := config.validate(); err != nil {
		t.Fatal(err)
	}
	b := &bridge{ctx: ctx, cancel: cancel, out: make(chan any, 256), pending: make(map[uint64]chan message), members: make(chan []member, 1), failure: make(chan error, 1)}
	r := &room{bridge: b, config: config, members: []member{{ParticipantID: "peer", Publications: []publication{{ID: "data", Name: "chat", Kind: "data", Delivery: "reliable"}, {ID: "audio", Name: "audio", Kind: "audio"}, {ID: "video", Name: "video", Kind: "video"}}}}}
	r.members[0].Publications = append(r.members[0].Publications, publication{ID: "withdrawn", Name: "chat", Kind: "data", Delivery: "reliable"})
	refreshed := make(chan struct{}, 1)
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	_, err = peer.CreateDataChannel("bootstrap", nil)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 8)
	remoteData := make(chan *webrtc.DataChannel, 1)
	peer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := track.ReadRTP(); err == nil {
			received <- track.Kind().String()
		}
		for {
			if _, _, err := track.ReadRTP(); err != nil {
				return
			}
		}
	})
	var senders []*source
	var tasks sync.WaitGroup
	defer tasks.Wait()
	defer cancel()
	tasks.Go(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case value := <-b.out:
				request, ok := value.(message)
				if !ok {
					if event, ok := value.(map[string]any); ok && event["kind"] == "data" {
						received <- "remote-data"
					}
					continue
				}
				var result any = map[string]any{}
				var failure error
				switch request.Method + " " + request.Path {
				case "POST ":
					offer, e := rtccore.LocalDescription(ctx, peer, true)
					failure = e
					result = opened{SessionID: "test-session", Offer: *offer}
				case "PUT /test-session":
					var body struct {
						Answer webrtc.SessionDescription `json:"answer"`
					}
					failure = json.Unmarshal(request.Body, &body)
					if failure == nil {
						failure = peer.SetRemoteDescription(body.Answer)
					}
					if len(senders) > 0 {
						for _, src := range senders {
							tasks.Go(func() {
								if err := src.run(); err != nil && ctx.Err() == nil {
									t.Error(err)
								}
							})
						}
						senders = nil
					}
				case "POST /test-session/publish":
					var body struct {
						Offer    *webrtc.SessionDescription `json:"offer"`
						Channels []publication              `json:"channels"`
					}
					failure = json.Unmarshal(request.Body, &body)
					if body.Offer != nil {
						failure = peer.SetRemoteDescription(*body.Offer)
						if failure == nil {
							answer, e := rtccore.LocalDescription(ctx, peer, false)
							failure = e
							result = exchange{Answer: answer, Publications: []publication{{ID: "local-audio", Name: "audio", Kind: "audio"}, {ID: "local-video", Name: "video", Kind: "video"}}}
						}
					} else {
						id := uint16(2)
						negotiated := true
						channel, e := peer.CreateDataChannel("chat", &webrtc.DataChannelInit{ID: &id, Negotiated: &negotiated})
						failure = e
						if failure == nil {
							channel.OnMessage(func(message webrtc.DataChannelMessage) {
								if len(message.Data) > 5 && json.Valid(message.Data[5:]) {
									received <- "data"
								}
							})
						}
						result = exchange{Publications: []publication{{ID: "local-data", Name: "chat", Kind: "data"}}, ChannelIDs: map[string]uint16{"local-data": 2}}
					}
				case "POST /test-session/unpublish":
					var body struct {
						Offer webrtc.SessionDescription `json:"offer"`
					}
					failure = json.Unmarshal(request.Body, &body)
					if failure == nil {
						failure = peer.SetRemoteDescription(body.Offer)
					}
					if failure == nil {
						answer, e := rtccore.LocalDescription(ctx, peer, false)
						failure = e
						result = exchange{Answer: answer}
					}
				case "GET /test-session":
					b.members <- []member{{ParticipantID: "peer", Publications: []publication{{ID: "data", Name: "chat", Kind: "data", Delivery: "reliable"}, {ID: "audio", Name: "audio", Kind: "audio"}, {ID: "video", Name: "video", Kind: "video"}}}}
					select {
					case refreshed <- struct{}{}:
					default:
					}
				case "POST /test-session/subscribe":
					var body struct {
						Kind  string         `json:"kind"`
						Items []subscription `json:"items"`
					}
					failure = json.Unmarshal(request.Body, &body)
					resultBody := exchange{}
					for _, item := range body.Items {
						if item.PublicationID == "withdrawn" {
							continue
						}
						if body.Kind == "data" {
							id := uint16(4)
							negotiated := true
							channel, e := peer.CreateDataChannel("chat", &webrtc.DataChannelInit{ID: &id, Negotiated: &negotiated})
							failure = e
							if failure == nil {
								remoteData <- channel
							}
							item.ChannelID = &id
						} else {
							path := audio
							if item.PublicationID == "video" {
								path = video
							}
							src, e := newSource(ctx, config, item.PublicationID, path)
							failure = e
							if failure == nil {
								transceiver, e := peer.AddTransceiverFromTrack(src.track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
								failure = e
								if e == nil {
									src.transceiver = transceiver
									senders = append(senders, src)
								}
							}
						}
						resultBody.Subscriptions = append(resultBody.Subscriptions, item)
					}
					if body.Kind == "media" && failure == nil {
						offer, e := rtccore.LocalDescription(ctx, peer, true)
						failure = e
						resultBody.Offer = offer
						for index, src := range senders {
							resultBody.Subscriptions[index].Mid = src.transceiver.Mid()
						}
					}
					result = resultBody
				}
				raw, _ := json.Marshal(result)
				reply := message{Kind: "response", Body: raw}
				if failure != nil {
					reply.Error = failure.Error()
				}
				b.mu.Lock()
				pending := b.pending[request.ID]
				b.mu.Unlock()
				if pending != nil {
					pending <- reply
				}
			}
		}
	})
	session, err := r.connect(ctx)
	if session != nil {
		defer session.close()
	}
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- session.serve() }()
	var remoteChannel *webrtc.DataChannel
	select {
	case remoteChannel = <-remoteData:
	case <-ctx.Done():
		t.Fatal("data subscription timed out")
	}
	for {
		session.mu.Lock()
		item := session.remote["peer:data"]
		ready := item != nil && item.channel.ReadyState() == webrtc.DataChannelStateOpen
		session.mu.Unlock()
		if ready && remoteChannel.ReadyState() == webrtc.DataChannelStateOpen {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("data channel did not open")
		case <-time.After(time.Millisecond):
		}
	}
	if err := remoteChannel.Send(append([]byte{0, 0, 0, 0, 1}, []byte(`{"reply":true}`)...)); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for len(seen) < 4 {
		select {
		case kind := <-received:
			seen[kind] = true
		case err := <-done:
			t.Fatalf("session ended early: %v", err)
		case <-ctx.Done():
			t.Fatalf("missing media/data: %v", seen)
		}
	}
	for {
		files, _ := filepath.Glob(filepath.Join(config.Output, "*.rtc"))
		valid := 0
		for _, path := range files {
			file, err := os.Open(path)
			if err != nil {
				continue
			}
			var size [4]byte
			if _, err = io.ReadFull(file, size[:]); err == nil {
				header := make([]byte, binary.BigEndian.Uint32(size[:]))
				if _, err = io.ReadFull(file, header); err == nil && json.Valid(header) {
					valid++
				}
			}
			file.Close()
		}
		if valid == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("missing receive archives: %v", files)
		case err := <-done:
			t.Fatalf("session ended early: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	select {
	case <-refreshed:
	case err := <-done:
		t.Fatalf("session ended after partial subscription: %v", err)
	case <-ctx.Done():
		t.Fatal("partial subscription did not refresh members")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("session did not stop")
	}
}
