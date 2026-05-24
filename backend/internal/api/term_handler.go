package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/harness"
)

// Term 把浏览器的 WS 桥接到 sandbox 内 tui-bridge 的 /session/:hid/term。
// 双向透传字节；文本帧（控制 JSON，如 resize）也原样转发。
// 这个 endpoint 只对 terminal kind 的 harness 有效。
func (h *SessionHandler) Term(c echo.Context) error {
	sess, access, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if harness.KindFor(inst.Type) != harness.KindTerminal {
		return echo.NewHTTPError(http.StatusBadRequest, "harness type is not terminal kind")
	}
	if inst.SandboxURL == nil || sess.HarnessSessionID == nil {
		return echo.NewHTTPError(http.StatusConflict, "session not ready")
	}

	clientWS, err := websocket.Accept(c.Response(), c.Request(), &websocket.AcceptOptions{
		InsecureSkipVerify: true, // CORS origins already filtered by Echo middleware
		// 64KB is plenty for typed input frames; PTY chunks are sized below.
	})
	if err != nil {
		log.Printf("[term] ws accept failed: %v", err)
		return nil // headers already sent; can't write a normal error
	}
	defer clientWS.CloseNow()

	// Connect upstream WS to the tui-bridge.
	upstreamURL := buildUpstreamTermURL(*inst.SandboxURL, *sess.HarnessSessionID)
	ctx, cancel := context.WithCancel(c.Request().Context())
	defer cancel()

	upstreamWS, _, err := websocket.Dial(ctx, upstreamURL, nil)
	if err != nil {
		log.Printf("[term] upstream dial %s failed: %v", upstreamURL, err)
		_ = clientWS.Close(websocket.StatusBadGateway, "upstream unreachable")
		return nil
	}
	defer upstreamWS.CloseNow()

	// Pump bytes in both directions. Either side closing tears down the other.
	errc := make(chan error, 2)
	go func() { errc <- pump(ctx, clientWS, upstreamWS) }()
	go func() { errc <- pump(ctx, upstreamWS, clientWS) }()

	if err := <-errc; err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		log.Printf("[term] pump ended: %v", err)
	}
	cancel()
	// give the other goroutine a beat to notice ctx, then drain
	select {
	case <-errc:
	case <-time.After(200 * time.Millisecond):
	}
	return nil
}

// pump forwards every message from src to dst preserving frame type
// (text frames stay text, binary stays binary).
func pump(ctx context.Context, src, dst *websocket.Conn) error {
	for {
		typ, data, err := src.Read(ctx)
		if err != nil {
			// signal the other direction to wind down
			_ = dst.Close(websocket.StatusNormalClosure, "peer closed")
			return err
		}
		if err := dst.Write(ctx, typ, data); err != nil {
			return err
		}
	}
}

func buildUpstreamTermURL(sandboxURL, harnessSessionID string) string {
	// sandboxURL is "http://<podIP>:<port>"; swap scheme for ws.
	u := strings.TrimRight(sandboxURL, "/")
	switch {
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + strings.TrimPrefix(u, "https://")
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	return fmt.Sprintf("%s/session/%s/term", u, harnessSessionID)
}
