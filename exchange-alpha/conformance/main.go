// Conformance client for Alpha Exchange.
//
// Built on QuickFIX/Go, an independent and widely used FIX engine, loading the exchange's own
// published dictionary (../spec/fix44.xml). If QuickFIX accepts everything the gateway sends,
// and the gateway handles everything QuickFIX sends, our hand-written FIX implementation agrees
// with someone else's, which proves far more than our own client agreeing with our own server.
//
//	go run . trade     QFGO1 and QFGO2 trade with each other, cancel, and get a validation reject
//	go run . rest      QFGO1 rests a sell order, then drops off without logging out
//	go run . take      QFGO2 buys at market, filling QFGO1's order while QFGO1 is away
//	go run . collect   QFGO1 logs back on and must receive that fill by resend
//
// run.sh runs all four, killing the gateway between `rest` and `take`.
package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/quickfixgo/quickfix"
	"github.com/quickfixgo/quickfix/log/screen"
	"github.com/quickfixgo/quickfix/store/file"
)

// FIX tags used here.
const (
	tagAccount          quickfix.Tag = 1
	tagAvgPx            quickfix.Tag = 6
	tagClOrdID          quickfix.Tag = 11
	tagCumQty           quickfix.Tag = 14
	tagLastPx           quickfix.Tag = 31
	tagLastQty          quickfix.Tag = 32
	tagMsgType          quickfix.Tag = 35
	tagOrderID          quickfix.Tag = 37
	tagOrderQty         quickfix.Tag = 38
	tagOrdStatus        quickfix.Tag = 39
	tagOrdType          quickfix.Tag = 40
	tagOrigClOrdID      quickfix.Tag = 41
	tagPossDupFlag      quickfix.Tag = 43
	tagPrice            quickfix.Tag = 44
	tagSide             quickfix.Tag = 54
	tagSymbol           quickfix.Tag = 55
	tagTimeInForce      quickfix.Tag = 59
	tagTransactTime     quickfix.Tag = 60
	tagOrdRejReason     quickfix.Tag = 103
	tagExecType         quickfix.Tag = 150
	tagLeavesQty        quickfix.Tag = 151
	tagLastLiquidityInd quickfix.Tag = 851
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . trade|rest|take|collect")
		os.Exit(2)
	}
	scenarios := map[string]func(*harness){
		"trade":   trade,
		"rest":    rest,
		"take":    take,
		"collect": collect,
	}
	scenario, ok := scenarios[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown scenario %q\n", os.Args[1])
		os.Exit(2)
	}
	h := &harness{}
	scenario(h)
	if h.failures > 0 {
		fmt.Printf("\n%s: %d check(s) FAILED\n", os.Args[1], h.failures)
		os.Exit(1)
	}
	fmt.Printf("\n%s: all checks passed\n", os.Args[1])
}

// trade: two QuickFIX sessions trade through the book.
func trade(h *harness) {
	h.logon("QFGO1", "QFGO2")
	run := runID()

	h.step("QFGO1 rests a sell: 100 ACME at 42.10")
	sellID := "sell-" + run
	h.send("QFGO1", limitOrder(sellID, "2", "100", "ACME", "42.10"))
	ack := h.next("QFGO1")
	h.expect(ack, tagExecType, "0", "acknowledged as New")
	h.expectPrefix(ack, tagOrderID, "ALPHA-", "venue order id")

	h.step("QFGO2 buys 60 at 42.10: one trade, each side told only about its own order")
	h.send("QFGO2", limitOrder("buy-"+run, "1", "60", "ACME", "42.10"))
	h.expect(h.next("QFGO2"), tagExecType, "0", "buyer acknowledged")
	bought := h.next("QFGO2")
	h.expect(bought, tagExecType, "F", "buyer gets a trade")
	h.expect(bought, tagOrdStatus, "2", "buyer filled")
	h.expect(bought, tagLastPx, "42.10", "at the resting price")
	h.expect(bought, tagAvgPx, "42.1000", "average price")
	h.expect(bought, tagLastLiquidityInd, "2", "buyer removed liquidity")
	sold := h.next("QFGO1")
	h.expect(sold, tagExecType, "F", "seller gets a trade")
	h.expect(sold, tagOrdStatus, "1", "seller partially filled")
	h.expect(sold, tagCumQty, "60", "seller cumulative quantity")
	h.expect(sold, tagLeavesQty, "40", "seller leaves quantity")
	h.expect(sold, tagLastLiquidityInd, "1", "seller added liquidity")

	h.step("QFGO2 sends an off-tick CRUX price (CRUX ticks in 0.05)")
	h.send("QFGO2", limitOrder("bad-"+run, "1", "10", "CRUX", "286.52"))
	rejected := h.next("QFGO2")
	h.expect(rejected, tagExecType, "8", "rejected")
	h.expect(rejected, tagOrdRejReason, "11", "unsupported order characteristic")

	h.step("QFGO1 cancels the 40 still resting")
	cancelID := "cxl-" + run
	h.send("QFGO1", cancelRequest(cancelID, sellID, "2", "ACME"))
	canceled := h.next("QFGO1")
	h.expect(canceled, tagExecType, "4", "canceled")
	h.expect(canceled, tagClOrdID, cancelID, "answers the cancel request")
	h.expect(canceled, tagLeavesQty, "0", "nothing left")

	h.stop()
}

// rest: QFGO1 places an order and vanishes without logging out.
func rest(h *harness) {
	h.logon("QFGO1")
	h.step("QFGO1 rests a sell: 100 ACME at 42.25, then drops off")
	h.send("QFGO1", limitOrder("rest-"+runID(), "2", "100", "ACME", "42.25"))
	h.expect(h.next("QFGO1"), tagExecType, "0", "acknowledged")
	// No Stop(), so no Logout: as abrupt as a network failure. QuickFIX's file store has
	// already recorded the sequence numbers.
}

// take: QFGO2 hits the resting order. QFGO1 is offline, so its fill must wait for it.
func take(h *harness) {
	h.logon("QFGO2")
	h.step("QFGO2 buys 100 ACME at market, against QFGO1's order from before the crash")
	h.send("QFGO2", marketOrder("take-"+runID(), "1", "100", "ACME"))
	h.expect(h.next("QFGO2"), tagExecType, "0", "acknowledged")
	fill := h.next("QFGO2")
	h.expect(fill, tagExecType, "F", "trade")
	h.expect(fill, tagOrdStatus, "2", "filled: the book survived the crash")
	h.expect(fill, tagLastPx, "42.25", "at the resting price")
	h.stop()
}

// collect: QFGO1 returns and must be told about the fill it missed.
func collect(h *harness) {
	h.logon("QFGO1")
	h.step("QFGO1 logs back on; the fill it missed arrives by resend")
	missed := h.next("QFGO1")
	h.expect(missed, tagExecType, "F", "the missed trade")
	h.expect(missed, tagOrdStatus, "2", "filled")
	h.expectHeader(missed, tagPossDupFlag, "Y", "marked as a possible duplicate")
	h.stop()
}

// --- harness ---

type harness struct {
	app       *app
	initiator *quickfix.Initiator
	failures  int
}

type app struct {
	logons   chan string
	received map[string]chan *quickfix.Message
	ids      map[string]quickfix.SessionID
}

func (a *app) OnCreate(id quickfix.SessionID)                { a.ids[id.SenderCompID] = id }
func (a *app) OnLogon(id quickfix.SessionID)                 { a.logons <- id.SenderCompID }
func (a *app) OnLogout(quickfix.SessionID)                   {}
func (a *app) ToAdmin(*quickfix.Message, quickfix.SessionID) {}
func (a *app) ToApp(*quickfix.Message, quickfix.SessionID) error {
	return nil
}
func (a *app) FromAdmin(*quickfix.Message, quickfix.SessionID) quickfix.MessageRejectError {
	return nil
}
func (a *app) FromApp(m *quickfix.Message, id quickfix.SessionID) quickfix.MessageRejectError {
	a.received[id.SenderCompID] <- m
	return nil
}

func (h *harness) logon(compIDs ...string) {
	addr := envOr("ALPHA_ADDR", "127.0.0.1:9878")
	host, port, _ := strings.Cut(addr, ":")
	var cfg strings.Builder
	fmt.Fprintf(&cfg, `[DEFAULT]
ConnectionType=initiator
BeginString=FIX.4.4
TargetCompID=ALPHA
SocketConnectHost=%s
SocketConnectPort=%s
HeartBtInt=5
ReconnectInterval=1
StartTime=00:00:00
EndTime=00:00:00
ResetOnLogon=N
FileStorePath=.store
UseDataDictionary=Y
DataDictionary=../spec/fix44.xml
`, host, port)
	for _, id := range compIDs {
		fmt.Fprintf(&cfg, "\n[SESSION]\nSenderCompID=%s\n", id)
	}
	settings, err := quickfix.ParseSettings(bytes.NewBufferString(cfg.String()))
	must(err)

	h.app = &app{
		logons:   make(chan string, len(compIDs)),
		received: map[string]chan *quickfix.Message{},
		ids:      map[string]quickfix.SessionID{},
	}
	for _, id := range compIDs {
		h.app.received[id] = make(chan *quickfix.Message, 100)
	}
	logs := screen.NewLogFactory()
	if os.Getenv("FIX_TRACE") == "" {
		logs = quietLogs{}
	}
	h.initiator, err = quickfix.NewInitiator(h.app, file.NewStoreFactory(settings), settings, logs)
	must(err)
	must(h.initiator.Start())

	for range compIDs {
		select {
		case id := <-h.app.logons:
			fmt.Printf("  logged on as %s\n", id)
		case <-time.After(10 * time.Second):
			fmt.Println("  FAIL  timed out waiting for logon")
			os.Exit(1)
		}
	}
}

func (h *harness) stop() { h.initiator.Stop() }

func (h *harness) step(text string) { fmt.Printf("\n%s\n", text) }

func (h *harness) send(compID string, m *quickfix.Message) {
	must(quickfix.SendToTarget(m, h.app.ids[compID]))
}

func (h *harness) next(compID string) *quickfix.Message {
	select {
	case m := <-h.app.received[compID]:
		return m
	case <-time.After(10 * time.Second):
		fmt.Printf("  FAIL  %s timed out waiting for a message\n", compID)
		os.Exit(1)
		return nil
	}
}

func (h *harness) expect(m *quickfix.Message, tag quickfix.Tag, want, what string) {
	got, _ := m.Body.GetString(tag)
	h.check(got == want, what, tag, got, want)
}

func (h *harness) expectHeader(m *quickfix.Message, tag quickfix.Tag, want, what string) {
	got, _ := m.Header.GetString(tag)
	h.check(got == want, what, tag, got, want)
}

func (h *harness) expectPrefix(m *quickfix.Message, tag quickfix.Tag, prefix, what string) {
	got, _ := m.Body.GetString(tag)
	h.check(strings.HasPrefix(got, prefix), what, tag, got, prefix+"...")
}

func (h *harness) check(ok bool, what string, tag quickfix.Tag, got, want string) {
	if ok {
		fmt.Printf("  pass  %-34s %d=%s\n", what, tag, got)
		return
	}
	h.failures++
	fmt.Printf("  FAIL  %-34s %d=%q, want %q\n", what, tag, got, want)
}

// --- messages ---

func newOrder(clOrdID, side, qty, symbol string) *quickfix.Message {
	m := quickfix.NewMessage()
	m.Header.SetString(tagMsgType, "D")
	m.Body.SetString(tagClOrdID, clOrdID)
	m.Body.SetString(tagAccount, "qf-acct")
	m.Body.SetString(tagSymbol, symbol)
	m.Body.SetString(tagSide, side)
	m.Body.SetString(tagTransactTime, utcNow())
	m.Body.SetString(tagOrderQty, qty)
	return m
}

func limitOrder(clOrdID, side, qty, symbol, price string) *quickfix.Message {
	m := newOrder(clOrdID, side, qty, symbol)
	m.Body.SetString(tagOrdType, "2")
	m.Body.SetString(tagPrice, price)
	m.Body.SetString(tagTimeInForce, "1") // GTC
	return m
}

func marketOrder(clOrdID, side, qty, symbol string) *quickfix.Message {
	m := newOrder(clOrdID, side, qty, symbol)
	m.Body.SetString(tagOrdType, "1")
	return m
}

func cancelRequest(clOrdID, origClOrdID, side, symbol string) *quickfix.Message {
	m := quickfix.NewMessage()
	m.Header.SetString(tagMsgType, "F")
	m.Body.SetString(tagOrigClOrdID, origClOrdID)
	m.Body.SetString(tagClOrdID, clOrdID)
	m.Body.SetString(tagAccount, "qf-acct")
	m.Body.SetString(tagSymbol, symbol)
	m.Body.SetString(tagSide, side)
	m.Body.SetString(tagTransactTime, utcNow())
	return m
}

// --- helpers ---

func utcNow() string { return time.Now().UTC().Format("20060102-15:04:05.000") }

// ClOrdIDs must never repeat, and the gateway remembers them across runs.
func runID() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// quietLogs discards QuickFIX's own logging; set FIX_TRACE=1 to see every message.
type quietLogs struct{}

func (quietLogs) Create() (quickfix.Log, error)                             { return quietLog{}, nil }
func (quietLogs) CreateSessionLog(quickfix.SessionID) (quickfix.Log, error) { return quietLog{}, nil }

type quietLog struct{}

func (quietLog) OnIncoming([]byte)               {}
func (quietLog) OnOutgoing([]byte)               {}
func (quietLog) OnEvent(string)                  {}
func (quietLog) OnEventf(string, ...interface{}) {}
