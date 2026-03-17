import { useState, useEffect, useRef } from "react";
import { searchReddit, fetchTrending, fetchPulseDashboard } from "./api";

// ── Design tokens ──────────────────────────────────────────────────────────────
const T = {
  bg:          "#0C0C0E",
  surface:     "#141416",
  surfaceHigh: "#1C1C20",
  border:      "rgba(255,255,255,0.07)",
  borderHover: "rgba(255,255,255,0.14)",
  text:        "#F0EDE8",
  textMuted:   "#888896",
  textFaint:   "#444458",
  accent:      "#FF5B36",
  accentSoft:  "rgba(255,91,54,0.12)",
  accentGlow:  "rgba(255,91,54,0.25)",
  green:       "#4ADE80",
  greenSoft:   "rgba(74,222,128,0.1)",
  yellow:      "#FBBF24",
  yellowSoft:  "rgba(251,191,36,0.1)",
  red:         "#F87171",
  redSoft:     "rgba(248,113,113,0.1)",
  blue:        "#60A5FA",
  blueSoft:    "rgba(96,165,250,0.1)",
};

const sentimentMap = {
  positive: { label: "Positive",  color: T.green,  bg: T.greenSoft,  dot: "#4ADE80" },
  neutral:  { label: "Neutral",   color: T.yellow, bg: T.yellowSoft, dot: "#FBBF24" },
  negative: { label: "Negative",  color: T.red,    bg: T.redSoft,    dot: "#F87171" },
};

const SUGGESTED = [
  "What's Reddit saying about AI in 2026?",
  "Latest drama on r/worldnews",
  "Best gaming discussions this week",
  "Climate change debate on Reddit",
  "Tech layoffs discussion",
  "Space exploration news",
];

// ── Tiny components ────────────────────────────────────────────────────────────

function SentimentBadge({ sentiment }) {
  const s = sentimentMap[sentiment] || sentimentMap.neutral;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
      color: s.color, background: s.bg,
      padding: "3px 9px", borderRadius: 20,
      textTransform: "uppercase",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

function SubredditTag({ name }) {
  return (
    <span style={{
      fontSize: 11, color: T.blue, background: T.blueSoft,
      padding: "2px 8px", borderRadius: 4, fontWeight: 500,
    }}>{name}</span>
  );
}

function Spinner({ size = 16 }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: `2px solid rgba(255,255,255,0.1)`,
      borderTopColor: T.accent,
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
      flexShrink: 0,
    }} />
  );
}

function SourceCard({ post, index }) {
  return (
    <a href={post.url} target="_blank" rel="noreferrer" style={{
      display: "block", textDecoration: "none",
      background: T.surfaceHigh,
      border: `1px solid ${T.border}`,
      borderRadius: 10, padding: "12px 14px",
      transition: "border-color 0.15s, transform 0.15s",
      cursor: "pointer",
    }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = T.borderHover; e.currentTarget.style.transform = "translateY(-1px)"; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: T.textFaint,
          background: T.surfaceHigh, border: `1px solid ${T.border}`,
          borderRadius: 4, padding: "1px 5px", flexShrink: 0, marginTop: 1,
        }}>{index + 1}</span>
        <p style={{ fontSize: 12, color: T.text, lineHeight: 1.4, margin: 0 }}>
          {post.title.slice(0, 70)}{post.title.length > 70 ? "…" : ""}
        </p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <SubredditTag name={post.subreddit} />
        <span style={{ fontSize: 11, color: T.textFaint }}>{post.num_comments} comments</span>
      </div>
    </a>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <Spinner size={14} />
      <span style={{ fontSize: 13, color: T.textMuted }}>Searching Reddit and thinking…</span>
    </div>
  );
}

// ── Answer bubble ──────────────────────────────────────────────────────────────
function AnswerBubble({ msg, onFollowUp }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);

  if (msg.type === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
        <div style={{
          background: T.accentSoft,
          border: `1px solid ${T.accentGlow}`,
          borderRadius: "18px 18px 4px 18px",
          padding: "12px 18px", maxWidth: "75%",
          fontSize: 15, color: T.text, lineHeight: 1.6,
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.type === "thinking") {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: "4px 18px 18px 18px",
          padding: "16px 20px", maxWidth: "85%",
        }}>
          <ThinkingDots />
        </div>
      </div>
    );
  }

  if (msg.type === "error") {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{
          background: T.redSoft, border: `1px solid rgba(248,113,113,0.2)`,
          borderRadius: "4px 18px 18px 18px",
          padding: "14px 18px", maxWidth: "85%",
          fontSize: 14, color: T.red,
        }}>
          ⚠ {msg.content}
        </div>
      </div>
    );
  }

  // AI answer
  const { summary, key_points, sentiment, timeline, subreddits, posts, query } = msg.data;

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Main answer card */}
      <div style={{
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: "4px 18px 18px 18px",
        padding: "22px 24px", maxWidth: "88%",
        animation: "fadeUp 0.3s ease-out",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: T.accentSoft, border: `1px solid ${T.accentGlow}`,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1L9 5H13L10 8L11 13L7 10.5L3 13L4 8L1 5H5L7 1Z" fill={T.accent} />
            </svg>
          </div>
          <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 500 }}>Reddit Pulse AI</span>
          <div style={{ marginLeft: "auto" }}>
            <SentimentBadge sentiment={sentiment} />
          </div>
        </div>

        {/* Summary */}
        <p style={{ fontSize: 15, color: T.text, lineHeight: 1.75, marginBottom: 20 }}>
          {summary}
        </p>

        {/* Key points */}
        {key_points?.length > 0 && (
          <div style={{
            background: T.surfaceHigh, borderRadius: 10,
            padding: "14px 16px", marginBottom: 20,
          }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: T.textFaint, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
              Key Points
            </p>
            {key_points.map((pt, i) => (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: i < key_points.length - 1 ? 8 : 0 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.accent, flexShrink: 0, marginTop: 6 }} />
                <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>{pt}</p>
              </div>
            ))}
          </div>
        )}

        {/* Timeline */}
        {timeline?.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: T.textFaint, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
              Timeline
            </p>
            {timeline.map((ev, i) => (
              <div key={i} style={{ display: "flex", gap: 12, marginBottom: i < timeline.length - 1 ? 10 : 0 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, marginTop: 4 }} />
                  {i < timeline.length - 1 && <div style={{ width: 1, flex: 1, background: T.border, marginTop: 3 }} />}
                </div>
                <p style={{ fontSize: 13, color: T.textMuted, paddingBottom: i < timeline.length - 1 ? 8 : 0, margin: 0 }}>{ev}</p>
              </div>
            ))}
          </div>
        )}

        {/* Subreddits */}
        {subreddits?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
            {subreddits.map((s, i) => <SubredditTag key={i} name={s} />)}
          </div>
        )}

        {/* Sources toggle */}
        {posts?.length > 0 && (
          <button
            onClick={() => setSourcesOpen(!sourcesOpen)}
            style={{
              background: "none", border: `1px solid ${T.border}`,
              borderRadius: 8, padding: "7px 14px",
              color: T.textMuted, fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              transition: "border-color 0.15s, color 0.15s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.borderHover; e.currentTarget.style.color = T.text; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6 4v4M4 6h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            {sourcesOpen ? "Hide" : "Show"} {posts.length} sources
          </button>
        )}
      </div>

      {/* Sources grid */}
      {sourcesOpen && posts?.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 8, marginTop: 10, maxWidth: "88%",
          animation: "fadeUp 0.2s ease-out",
        }}>
          {posts.map((p, i) => <SourceCard key={p.id} post={p} index={i} />)}
        </div>
      )}

      {/* Follow-up suggestions */}
      {msg.followUps?.length > 0 && (
        <div style={{ marginTop: 14, maxWidth: "88%" }}>
          <p style={{ fontSize: 11, color: T.textFaint, marginBottom: 8, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Ask follow-up
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {msg.followUps.map((fu, i) => (
              <button key={i} onClick={() => onFollowUp(fu)} style={{
                background: T.surfaceHigh, border: `1px solid ${T.border}`,
                borderRadius: 20, padding: "7px 14px",
                fontSize: 12, color: T.textMuted, cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; e.currentTarget.style.background = T.accentSoft; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = T.surfaceHigh; }}
              >
                {fu}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trending sidebar ───────────────────────────────────────────────────────────
function TrendingSidebar({ trending, onAsk }) {
  return (
    <div style={{
      width: 260, flexShrink: 0,
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: 14, padding: "16px",
      height: "fit-content", position: "sticky", top: 80,
    }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: T.textFaint, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
        🔥 Trending on Reddit
      </p>
      {trending.length === 0 ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Spinner size={12} />
          <span style={{ fontSize: 12, color: T.textFaint }}>Loading…</span>
        </div>
      ) : trending.map((t, i) => (
        <button key={t.id} onClick={() => onAsk(t.title)} style={{
          display: "block", width: "100%", textAlign: "left",
          background: "none", border: "none", cursor: "pointer",
          padding: "8px 0",
          borderBottom: i < trending.length - 1 ? `1px solid ${T.border}` : "none",
        }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, color: T.textFaint, minWidth: 14, marginTop: 1 }}>{i + 1}</span>
            <div>
              <p style={{ fontSize: 12, color: T.text, lineHeight: 1.4, margin: "0 0 4px" }}>
                {t.title.slice(0, 50)}{t.title.length > 50 ? "…" : ""}
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 10, color: T.blue }}>{t.subreddits?.[0]}</span>
                <span style={{ fontSize: 10, color: T.textFaint }}>· {t.growth}</span>
              </div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Generate follow-up questions from result ───────────────────────────────────
function generateFollowUps(query, data) {
  const sub = data.subreddits?.[0] || "Reddit";
  return [
    `What do people on ${sub} think about this?`,
    `What are the top comments saying?`,
    `Is this mostly positive or negative?`,
    `Tell me more about the controversy`,
  ].slice(0, 3);
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [trending, setTrending] = useState([]);
  const [started, setStarted] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Load trending on mount
  useEffect(() => {
    fetchTrending(5).then(setTrending).catch(() => {});
  }, []);

  // Auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const ask = async (query) => {
    if (!query.trim() || loading) return;
    setStarted(true);
    setInput("");

    // Add user message
    const userMsg = { id: Date.now(), type: "user", content: query };
    const thinkingMsg = { id: Date.now() + 1, type: "thinking" };
    setMessages(prev => [...prev, userMsg, thinkingMsg]);
    setLoading(true);

    try {
      // Detect if this is a follow-up or new topic
      const queryLower = query.toLowerCase().trim();
      const followupSignals = ["this", "it", "that", "they", "he", "she", "the issue", "more", "why", "how", "what about", "tell me", "explain", "right?", "really?"];
      const isShort = query.split(" ").length <= 10;
      const hasSignal = followupSignals.some(s => queryLower.includes(s)) || queryLower.endsWith("?");
      const isFollowup = isShort && hasSignal && messages.length > 0;

      // Build history only for follow-ups
      const history = isFollowup
        ? messages
            .filter(m => m.type === "user" || m.type === "answer")
            .slice(-6)
            .flatMap(m => m.type === "user"
              ? [{ role: "user", content: m.content }]
              : [{ role: "assistant", content: m.data?.summary || "" }]
            )
        : [];

      const result = await searchReddit(query, history);

      if (result.error) throw new Error(result.error);

      const followUps = generateFollowUps(query, result);

      const aiMsg = {
        id: Date.now() + 2,
        type: "answer",
        data: result,
        followUps,
      };

      setMessages(prev => [...prev.filter(m => m.type !== "thinking"), aiMsg]);
    } catch (err) {
      setMessages(prev => [...prev.filter(m => m.type !== "thinking"), {
        id: Date.now() + 2,
        type: "error",
        content: "Could not fetch Reddit data. Is the backend running?",
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleSubmit = (e) => {
    e?.preventDefault();
    ask(input.trim());
  };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${T.bg}; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 2px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
        input::placeholder { color: ${T.textFaint}; }
        textarea::placeholder { color: ${T.textFaint}; }
        a { text-decoration: none; }
      `}</style>

      {/* Header */}
      <header style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        background: `${T.bg}cc`,
        backdropFilter: "blur(12px)",
        borderBottom: `1px solid ${T.border}`,
        height: 56, display: "flex", alignItems: "center",
        padding: "0 24px", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 9,
            background: T.accent, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 16px ${T.accentGlow}`,
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1L9 5H13L10 8L11 13L7 10.5L3 13L4 8L1 5H5L7 1Z" fill="white" />
            </svg>
          </div>
          <span style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 18, color: T.text }}>
            Reddit Pulse
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600, color: T.accent,
            background: T.accentSoft, padding: "2px 7px", borderRadius: 4,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>AI</span>
        </div>

        {started && (
          <button onClick={() => { setMessages([]); setStarted(false); setInput(""); }}
            style={{
              background: T.surfaceHigh, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: "6px 14px",
              color: T.textMuted, fontSize: 12, cursor: "pointer",
            }}>
            New chat
          </button>
        )}
      </header>

      {/* Layout */}
      <div style={{ paddingTop: 56, minHeight: "100vh", display: "flex" }}>

        {/* Main column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", maxWidth: 760, margin: "0 auto", padding: "0 24px", width: "100%" }}>

          {/* Landing / empty state */}
          {!started && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 0 140px", animation: "fadeUp 0.4s ease-out" }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16,
                background: T.accentSoft, border: `1px solid ${T.accentGlow}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                marginBottom: 20, boxShadow: `0 0 32px ${T.accentGlow}`,
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2L15 9H22L17 13L19 21L12 17L5 21L7 13L2 9H9L12 2Z" fill={T.accent} />
                </svg>
              </div>
              <h1 style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 36, fontWeight: 400, color: T.text, marginBottom: 10, textAlign: "center" }}>
                Ask Reddit anything
              </h1>
              <p style={{ fontSize: 15, color: T.textMuted, textAlign: "center", maxWidth: 400, lineHeight: 1.7, marginBottom: 40 }}>
                AI-powered answers sourced from real Reddit discussions. Ask anything and get summaries, sentiment, and sources.
              </p>

              {/* Suggested questions */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 560 }}>
                {SUGGESTED.map((s, i) => (
                  <button key={i} onClick={() => ask(s)} style={{
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: 20, padding: "8px 16px",
                    fontSize: 13, color: T.textMuted, cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.text; e.currentTarget.style.background = T.accentSoft; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = T.surface; }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chat messages */}
          {started && (
            <div style={{ flex: 1, padding: "32px 0 180px" }}>
              {messages.map(msg => (
                <AnswerBubble key={msg.id} msg={msg} onFollowUp={ask} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Trending sidebar — only on wide screens */}
        {!started && (
          <div style={{ width: 280, padding: "80px 24px 24px 0", display: "none" }} className="sidebar">
            <TrendingSidebar trending={trending} onAsk={ask} />
          </div>
        )}
      </div>

      {/* Fixed input bar */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: `linear-gradient(to top, ${T.bg} 60%, transparent)`,
        padding: "20px 24px 28px",
        display: "flex", justifyContent: "center",
      }}>
        <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 720 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: 16, padding: "10px 10px 10px 18px",
            boxShadow: `0 0 0 1px transparent, 0 8px 32px rgba(0,0,0,0.4)`,
            transition: "border-color 0.2s, box-shadow 0.2s",
          }}
          onFocus={() => {}}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={started ? "Ask a follow-up question…" : "Ask anything about Reddit…"}
              rows={1}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontSize: 15, color: T.text, fontFamily: "inherit",
                resize: "none", lineHeight: 1.5, maxHeight: 120,
                overflowY: "auto",
              }}
              disabled={loading}
            />

            {/* Trending chips inside input when empty */}
            {!started && !input && trending.length > 0 && (
              <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                {trending.slice(0, 2).map((t, i) => (
                  <button key={i} type="button" onClick={() => ask(t.title)} style={{
                    background: T.surfaceHigh, border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: "4px 10px",
                    fontSize: 11, color: T.textMuted, cursor: "pointer",
                    whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {t.title.slice(0, 20)}…
                  </button>
                ))}
              </div>
            )}

            <button type="submit" disabled={loading || !input.trim()} style={{
              width: 38, height: 38, borderRadius: 10, flexShrink: 0,
              background: input.trim() && !loading ? T.accent : T.surfaceHigh,
              border: "none", cursor: input.trim() && !loading ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.2s, box-shadow 0.2s",
              boxShadow: input.trim() && !loading ? `0 0 12px ${T.accentGlow}` : "none",
            }}>
              {loading ? <Spinner size={16} /> : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8H13M9 4L13 8L9 12" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>

          <p style={{ fontSize: 11, color: T.textFaint, textAlign: "center", marginTop: 8 }}>
            Sourced from real Reddit discussions · Powered by Groq AI
          </p>
        </form>
      </div>
    </div>
  );
}