from __future__ import annotations
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq
import io
import os
import re
import json
import pickle
import httpx
import time
from datetime import datetime

from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

try:
    import PyPDF2
except ImportError:
    import subprocess; subprocess.check_call(["pip", "install", "PyPDF2"])
    import PyPDF2

try:
    import docx
except ImportError:
    import subprocess; subprocess.check_call(["pip", "install", "python-docx"])
    import docx

try:
    import pandas as pd
except ImportError:
    import subprocess; subprocess.check_call(["pip", "install", "pandas", "openpyxl"])
    import pandas as pd

try:
    from PIL import Image
    import pytesseract
except ImportError:
    import subprocess; subprocess.check_call(["pip", "install", "Pillow", "pytesseract"])
    from PIL import Image
    import pytesseract


# ── App setup ──────────────────────────────────────────────────────────────────

app = FastAPI(title="Reddit Pulse API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Groq client ────────────────────────────────────────────────────────────────
GROQ_API_KEY  = os.getenv("GROQ_API_KEY", "")
groq_client   = Groq(api_key=GROQ_API_KEY)

# Two models: fast cheap one for trending cards, smart one for search summaries
GROQ_MODEL_SMART = "llama-3.3-70b-versatile"         # search summaries — excellent JSON compliance
GROQ_MODEL_FAST  = "llama-3.1-8b-instant"  # general chat — fast + cheap

# ── Reddit public JSON ─────────────────────────────────────────────────────────
REDDIT_BASE = "https://www.reddit.com"
HEADERS     = {"User-Agent": "RedditPulseApp/1.0"}

# ── Trending cache — 10 min TTL, avoids burning Groq calls on every page load ──
CACHE_TTL = 600  # seconds
_trending_cache    = {"data": [], "timestamp": 0}
_dashboard_cache   = {"data": None, "timestamp": 0}

# ── Embedding model + RAG state ────────────────────────────────────────────────
embedding_model   = SentenceTransformer("all-MiniLM-L6-v2")
conversation_history = []
file_chunks: list[str] = []
file_embeddings   = None
faiss_index       = None
file_uploaded     = False
uploaded_filename = ""


# ══════════════════════════════════════════════════════════════════════════════
# REDDIT HELPERS
# ══════════════════════════════════════════════════════════════════════════════

async def fetch_reddit_json(url: str) -> dict:
    async with httpx.AsyncClient(headers=HEADERS, timeout=15) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.json()


async def get_trending_topics(limit: int = 5) -> list[dict]:
    """
    Pull hot posts from r/all.
    NO Groq calls here — raw Reddit data only.
    Groq only fires when the user actively searches.
    """
    data  = await fetch_reddit_json(f"{REDDIT_BASE}/r/all/hot.json?limit=50")
    posts = data["data"]["children"]
    topics = []

    for post in posts[:limit]:
        p         = post["data"]
        title     = p.get("title", "")[:80]
        selftext  = p.get("selftext", "")[:200]
        subreddit = p["subreddit"]
        sentiment = _quick_sentiment(title + " " + selftext)

        # Build a lightweight summary from raw data — zero Groq calls
        comment_count = p.get("num_comments", 0)
        score         = p.get("score", 0)
        summary = (
            f"{title} — posted on r/{subreddit} with {score:,} upvotes "
            f"and {comment_count:,} comments. "
            + (selftext[:120] + "..." if selftext else "Click to explore the full Reddit discussion.")
        )

        topics.append({
            "id":         p["id"],
            "title":      title,
            "subreddits": [f"r/{subreddit}"],
            "sentiment":  sentiment,
            "posts":      comment_count,
            "growth":     f"+{min(99, round(p.get('upvote_ratio', 0.5) * 100))}%",
            "url":        f"https://www.reddit.com{p['permalink']}",
            "score":      score,
            "summary":    summary,
            "points":     [
                f"{score:,} upvotes on r/{subreddit}",
                f"{comment_count:,} comments in the thread",
                "Click to get the full AI summary",
            ],
            "timeline":   [
                f"Posted on r/{subreddit}",
                f"Reached {score:,} upvotes",
                "Community discussion ongoing",
            ],
        })

    return topics


async def search_reddit_posts(query: str, limit: int = 8) -> list[dict]:
    """
    Multi-strategy Reddit search for maximum relevance.
    Tries relevance, top-of-all-time, and most-commented sorts.
    Deduplicates by post id and returns up to limit posts.
    """
    encoded  = query.replace(" ", "+")
    seen_ids = set()
    results  = []

    strategies = [
        f"{REDDIT_BASE}/search.json?q={encoded}&sort=relevance&limit=10&type=link",
        f"{REDDIT_BASE}/search.json?q={encoded}&sort=top&t=all&limit=10&type=link",
        f"{REDDIT_BASE}/search.json?q={encoded}&sort=comments&limit=10&type=link",
    ]

    for url in strategies:
        if len(results) >= limit:
            break
        try:
            data  = await fetch_reddit_json(url)
            posts = data["data"]["children"]
            for post in posts:
                p   = post["data"]
                pid = p["id"]
                if pid in seen_ids:
                    continue
                seen_ids.add(pid)
                results.append({
                    "id":           pid,
                    "title":        p["title"],
                    "subreddit":    f"r/{p['subreddit']}",
                    "score":        p.get("score", 0),
                    "num_comments": p.get("num_comments", 0),
                    "url":          f"https://www.reddit.com{p['permalink']}",
                    "selftext":     p.get("selftext", "")[:600],
                    "upvote_ratio": p.get("upvote_ratio", 0.5),
                })
                if len(results) >= limit:
                    break
        except Exception as e:
            print(f"Search strategy failed: {e}")
            continue

    return results


async def get_post_comments(post_id: str, subreddit: str, limit: int = 15) -> list[str]:
    """Fetch top comments — no Groq."""
    data = await fetch_reddit_json(
        f"{REDDIT_BASE}/r/{subreddit}/comments/{post_id}.json?limit={limit}&depth=1&sort=top"
    )
    comments = []
    if len(data) > 1:
        for c in data[1]["data"]["children"]:
            body = c["data"].get("body", "")
            if body and body not in ("[deleted]", "[removed]"):
                comments.append(body[:400])
    return comments


async def get_subreddit_hot(subreddit: str, limit: int = 5) -> list[dict]:
    data  = await fetch_reddit_json(f"{REDDIT_BASE}/r/{subreddit}/hot.json?limit={limit}")
    posts = []
    for post in data["data"]["children"]:
        p = post["data"]
        posts.append({
            "title":        p["title"],
            "score":        p.get("score", 0),
            "num_comments": p.get("num_comments", 0),
            "url":          f"https://www.reddit.com{p['permalink']}",
        })
    return posts


def _quick_sentiment(text: str) -> str:
    text_lower = text.lower()
    neg_words  = ["war","crisis","crash","layoff","ban","threat","fail","loss","risk",
                  "danger","attack","killed","dead","terror","conflict","complaint","arrest",
                  "accused","controversy","disrespect","protest","scam","fraud","abuse"]
    pos_words  = ["launch","release","new","record","growth","breakthrough","open","free",
                  "win","best","great","amazing","exciting","victory","celebrate","champion",
                  "love","support","defend","hero"]
    neg_score  = sum(1 for w in neg_words if w in text_lower)
    pos_score  = sum(1 for w in pos_words if w in text_lower)
    if pos_score > neg_score:   return "positive"
    elif neg_score > pos_score: return "negative"
    return "neutral"


# ══════════════════════════════════════════════════════════════════════════════
# GROQ HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def groq_chat(messages: list[dict], model: str = GROQ_MODEL_SMART, max_tokens: int = 2048) -> str:
    """Single Groq call with selectable model."""
    response = groq_client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.4,
    )
    return response.choices[0].message.content


def build_search_prompt(query: str, posts: list[dict], comments_map: dict) -> str:
    """Rich prompt for the smart model — fired only on user search."""
    posts_text = ""
    for i, post in enumerate(posts, 1):
        posts_text += f"\n--- Post {i} ---\n"
        posts_text += f"Title: {post['title']}\n"
        posts_text += f"Subreddit: {post['subreddit']} | Score: {post['score']} | Comments: {post['num_comments']}\n"
        if post.get("selftext"):
            posts_text += f"Body: {post['selftext'][:400]}\n"
        comments = comments_map.get(post["id"], [])
        if comments:
            posts_text += "Top comments:\n"
            for c in comments[:5]:
                posts_text += f"  - {c[:200]}\n"

    subreddits_list = list(set([p["subreddit"] for p in posts]))

    return f"""You are an expert Reddit analyst with deep knowledge of internet culture and current events.

The user is asking about: "{query}"

Reddit data collected for this topic:
{posts_text}

INSTRUCTIONS:
1. Write a DETAILED, SPECIFIC 2-4 sentence summary about "{query}" using the actual post and comment data above
2. Key points must be SPECIFIC facts or opinions found in the data — not generic statements
3. Timeline must reflect the actual progression of this discussion
4. Sentiment must reflect the overall Reddit community tone
5. NEVER say "no mention found" — always extract relevant insights
6. If posts are partially related, extract the most relevant insights for "{query}"
7. The Reddit data may be from any time period. Analyse what IS there — do not complain about what is missing
8. If the exact event is not in the data, summarise the closest related discussions and note the context

Reply with ONLY this JSON — no markdown, no backticks, no text outside the JSON:
{{"summary":"detailed 2-4 sentence summary specifically about {query}","key_points":["specific point 1","specific point 2","specific point 3","specific point 4"],"sentiment":"positive or neutral or negative","timeline":["specific event 1","specific event 2","specific event 3"],"subreddits":{json.dumps(subreddits_list)}}}"""


def parse_groq_json(raw: str, fallback: dict) -> dict:
    """Robustly extract JSON from Groq response."""
    print(f"\n=== GROQ RAW ===\n{raw}\n================\n")
    for attempt in [
        lambda s: json.loads(re.sub(r"```json|```", "", s).strip()),
        lambda s: json.loads(s[s.find('{'):s.rfind('}')+1]),
        lambda s: json.loads(re.search(r'\{.*\}', s, re.DOTALL).group()),
    ]:
        try:
            return attempt(raw)
        except Exception:
            continue
    print("All JSON parse attempts failed — using fallback")
    return fallback


# ══════════════════════════════════════════════════════════════════════════════
# FILE PARSING (unchanged)
# ══════════════════════════════════════════════════════════════════════════════

def extract_text_from_pdf(file_bytes):
    pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
    return "\n".join(page.extract_text() or "" for page in pdf_reader.pages)

def extract_text_from_docx(file_bytes):
    doc = docx.Document(io.BytesIO(file_bytes))
    return "\n".join(p.text for p in doc.paragraphs)

def extract_text_from_txt(file_bytes):
    return file_bytes.decode("utf-8", errors="ignore")

def extract_text_from_csv(file_bytes):
    df = pd.read_csv(io.BytesIO(file_bytes))
    return "CSV Data:\n\n" + df.to_string(index=False)

def extract_text_from_xlsx(file_bytes):
    df = pd.read_excel(io.BytesIO(file_bytes))
    return "Excel Data:\n\n" + df.to_string(index=False)

def extract_text_from_image(file_bytes):
    try:
        image = Image.open(io.BytesIO(file_bytes))
        return pytesseract.image_to_string(image)
    except Exception as e:
        return f"Error extracting text from image: {e}"

def extract_text_from_file(file_bytes, filename):
    ext = filename.lower().split(".")[-1]
    extractors = {
        "pdf": extract_text_from_pdf, "docx": extract_text_from_docx,
        "doc": extract_text_from_docx, "txt": extract_text_from_txt,
        "csv": extract_text_from_csv, "xlsx": extract_text_from_xlsx,
        "xls": extract_text_from_xlsx, "png": extract_text_from_image,
        "jpg": extract_text_from_image, "jpeg": extract_text_from_image,
    }
    extractor = extractors.get(ext)
    if not extractor:
        raise ValueError(f"Unsupported file type: {ext}")
    return extractor(file_bytes)

def chunk_text(text, chunk_size=500, overlap=100):
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size - overlap):
        chunk = " ".join(words[i:i + chunk_size])
        if chunk.strip():
            chunks.append(chunk)
    return chunks

def create_embeddings(chunks):
    return embedding_model.encode(chunks)

def build_faiss_index(embeddings):
    dimension = embeddings.shape[1]
    index = faiss.IndexFlatL2(dimension)
    index.add(embeddings.astype("float32"))
    return index

def retrieve_relevant_chunks(query, top_k=3):
    if faiss_index is None or not file_chunks:
        return []
    query_embedding = embedding_model.encode([query])
    distances, indices = faiss_index.search(query_embedding.astype("float32"), top_k)
    return [file_chunks[i] for i in indices[0]]


# ══════════════════════════════════════════════════════════════════════════════
# API ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

class ChatRequest(BaseModel):
    message: str

class SearchRequest(BaseModel):
    query:   str
    history: list[dict] = []


# ── Trending — cached, zero Groq calls after first load ───────────────────────

@app.get("/trending")
async def trending(limit: int = 5):
    now = time.time()
    # Serve from cache if still fresh
    if _trending_cache["data"] and (now - _trending_cache["timestamp"]) < CACHE_TTL:
        print(f"[CACHE HIT] /trending — serving cached data, {int(CACHE_TTL - (now - _trending_cache['timestamp']))}s left")
        return {"topics": _trending_cache["data"][:limit], "cached": True}

    print("[CACHE MISS] /trending — fetching fresh Reddit data (no Groq calls)")
    try:
        topics = await get_trending_topics(limit=limit)
        _trending_cache["data"]      = topics
        _trending_cache["timestamp"] = now
        return {"topics": topics, "cached": False}
    except Exception as e:
        # Return stale cache if available rather than crashing
        if _trending_cache["data"]:
            print(f"[CACHE STALE] Reddit fetch failed ({e}), serving stale cache")
            return {"topics": _trending_cache["data"][:limit], "cached": True, "stale": True}
        return {"error": str(e), "topics": []}


# ── Pulse dashboard — cached, zero Groq calls ─────────────────────────────────

@app.get("/pulse-dashboard")
async def pulse_dashboard():
    now = time.time()
    if _dashboard_cache["data"] and (now - _dashboard_cache["timestamp"]) < CACHE_TTL:
        print("[CACHE HIT] /pulse-dashboard")
        return _dashboard_cache["data"]

    print("[CACHE MISS] /pulse-dashboard — fetching fresh Reddit data")
    try:
        data  = await fetch_reddit_json(f"{REDDIT_BASE}/r/all/hot.json?limit=25")
        posts = data["data"]["children"]

        if not posts:
            return {"error": "Could not fetch Reddit data"}

        raw_topics = []
        for post in posts:
            p = post["data"]
            raw_topics.append({
                "title":     p.get("title", "")[:80],
                "subreddit": f"r/{p['subreddit']}",
                "score":     p.get("score", 0),
                "comments":  p.get("num_comments", 0),
            })

        hottest       = max(raw_topics, key=lambda t: t["score"])
        fastest       = max(raw_topics, key=lambda t: t["comments"])
        controversial = max(raw_topics, key=lambda t: t["comments"] * 0.5 + t["score"] * 0.5)

        subreddit_counts = {}
        for t in raw_topics:
            s = t["subreddit"]
            subreddit_counts[s] = subreddit_counts.get(s, 0) + 1
        most_active = max(subreddit_counts, key=subreddit_counts.get)

        result = {
            "hottest":               {"title": hottest["title"],       "sub": f"{hottest['score']:,} upvotes"},
            "fastest_growing":       {"title": fastest["title"],       "sub": f"{fastest['comments']:,} comments"},
            "most_controversial":    {"title": controversial["title"], "sub": "High engagement"},
            "most_active_community": {"title": most_active,            "sub": "Cross-thread dominance"},
        }
        _dashboard_cache["data"]      = result
        _dashboard_cache["timestamp"] = now
        return result
    except Exception as e:
        if _dashboard_cache["data"]:
            return _dashboard_cache["data"]
        return {"error": str(e)}


# ── Search — 1 Groq call (smart model), fired only on user action ─────────────

@app.post("/search-reddit")
async def search_reddit_endpoint(req: SearchRequest):
    try:
        is_followup = len(req.history) > 0

        # Detect if this is truly a follow-up or a brand new unrelated topic
        if is_followup:
            original_query = next(
                (h["content"] for h in req.history if h.get("role") == "user"), req.query
            )
            # Check if new query shares keywords with the original topic
            orig_words = set(original_query.lower().split())
            new_words  = set(req.query.lower().split())
            # Remove common stop words before comparing
            stop_words = {"a","an","the","is","it","in","on","at","to","for","of","and",
                          "or","but","not","with","this","that","are","was","be","by",
                          "do","did","does","right","but","just","so","what","how","why",
                          "when","where","who","which","about","more","very","too","can",
                          "best","good","any","some","has","have","had","been","would"}
            orig_keywords = orig_words - stop_words
            new_keywords  = new_words  - stop_words
            overlap = orig_keywords & new_keywords

            # If less than 1 keyword overlaps, treat as a new independent search
            is_new_topic = len(overlap) < 1

            if is_new_topic:
                print(f"[TOPIC SWITCH] Detected new topic: '{req.query}' (no overlap with '{original_query}')")
                is_followup  = False
                search_query = req.query
            else:
                print(f"[FOLLOW-UP] '{req.query}' follows '{original_query}' (overlap: {overlap})")
                search_query = original_query
        else:
            search_query = req.query

        posts = await search_reddit_posts(search_query, limit=8)
        if not posts:
            return {"error": f"No Reddit posts found for: {search_query}"}

        # Fetch comments (pure Reddit, no Groq)
        comments_map = {}
        for post in posts:
            subreddit = post["subreddit"].replace("r/", "")
            try:
                comments_map[post["id"]] = await get_post_comments(post["id"], subreddit, limit=15)
            except Exception:
                comments_map[post["id"]] = []

        subreddits_list = list(set([p["subreddit"] for p in posts]))

        # Build rich post+comment context string
        posts_text = ""
        for i, post in enumerate(posts, 1):
            posts_text += f"\n--- Post {i} ---\n"
            posts_text += f"Title: {post['title']}\n"
            posts_text += f"Subreddit: {post['subreddit']} | Score: {post['score']} | Comments: {post['num_comments']}\n"
            if post.get("selftext"):
                posts_text += f"Body: {post['selftext'][:400]}\n"
            comments = comments_map.get(post["id"], [])
            if comments:
                posts_text += "Top comments:\n"
                for c in comments[:5]:
                    posts_text += f"  - {c[:200]}\n"

        # ── 1 Groq call (smart model) ──────────────────────────────────────────
        messages = []

        if is_followup:
            messages.append({
                "role": "system",
                "content": (
                    f'You are an expert Reddit analyst.\n'
                    f'The user is asking a follow-up question about the topic: "{original_query}".\n'
                    f'The fresh Reddit data below is about "{original_query}" — use it to answer the follow-up.\n'
                    f'Reply ONLY with this JSON (no markdown, no backticks, no extra text):\n'
                    f'{{"summary":"2-4 sentence answer directly addressing the follow-up question using the Reddit data",'
                    f'"key_points":["specific point 1","specific point 2","specific point 3","specific point 4"],'
                    f'"sentiment":"positive or neutral or negative",'
                    f'"timeline":["event 1","event 2","event 3"],'
                    f'"subreddits":{json.dumps(subreddits_list)}}}\n'
                    f'Rules: sentiment must be positive, neutral, or negative. Output ONLY the JSON object.'
                )
            })

            # Only pass last 4 exchanges to avoid context bleed
            for h in req.history[-4:]:
                if h.get("role") and h.get("content"):
                    messages.append({"role": h["role"], "content": str(h["content"])[:600]})

            messages.append({
                "role": "user",
                "content": (
                    f"Follow-up question: {req.query}\n\n"
                    f'Fresh Reddit data about "{original_query}":\n{posts_text}\n\n'
                    f"Answer ONLY the follow-up question above. Do not answer any other topic. Reply ONLY with JSON."
                )
            })
        else:
            prompt = build_search_prompt(req.query, posts, comments_map)
            messages.append({"role": "user", "content": prompt})

        print(f"[GROQ CALL] model={GROQ_MODEL_SMART} query={req.query[:60]}")
        raw = groq_chat(messages, model=GROQ_MODEL_SMART, max_tokens=2048)

        fallback = {
            "summary":    f"Reddit has active discussions about '{req.query}' across {len(subreddits_list)} subreddits.",
            "key_points": [
                f"{len(posts)} Reddit posts found",
                f"Most active in: {subreddits_list[0] if subreddits_list else 'various subreddits'}",
                "Community engagement ongoing",
                "Multiple perspectives being shared",
            ],
            "sentiment":  _quick_sentiment(req.query),
            "timeline":   ["Posts published", "Community discussion growing", "Multiple perspectives emerging"],
            "subreddits": subreddits_list,
        }

        result          = parse_groq_json(raw, fallback)
        result["posts"] = posts
        result["query"] = req.query
        return result

    except Exception as e:
        print(f"ERROR /search-reddit: {e}")
        return {"error": str(e)}


# ── Subreddit explorer — no Groq ──────────────────────────────────────────────

@app.get("/subreddit/{subreddit}")
async def subreddit_posts(subreddit: str, limit: int = 5):
    try:
        posts = await get_subreddit_hot(subreddit, limit=limit)
        return {"subreddit": f"r/{subreddit}", "posts": posts}
    except Exception as e:
        return {"error": str(e)}


@app.get("/post/{subreddit}/{post_id}/comments")
async def post_comments(subreddit: str, post_id: str):
    try:
        comments = await get_post_comments(post_id, subreddit)
        return {"post_id": post_id, "comments": comments}
    except Exception as e:
        return {"error": str(e)}


# ── General chat (RAG) — uses fast model to save tokens ───────────────────────

@app.post("/chat")
def chat(request: ChatRequest):
    conversation_history.append({"role": "user", "content": request.message})

    relevant_chunks = []
    if file_uploaded:
        relevant_chunks = retrieve_relevant_chunks(request.message, top_k=3)

    if file_uploaded and relevant_chunks:
        context       = "\n\n".join(f"[Context {i+1}]: {chunk}" for i, chunk in enumerate(relevant_chunks))
        system_prompt = f"You are a helpful assistant. Document uploaded: {uploaded_filename}.\nCONTEXT:\n{context}"
        source_type   = "document"
    else:
        system_prompt = "You are a helpful assistant. Answer clearly and concisely."
        source_type   = "general"

    messages = [{"role": "system", "content": system_prompt}]
    for msg in conversation_history[:-1]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": request.message})

    try:
        # Use fast model for general chat — saves smart model quota for search
        print(f"[GROQ CALL] model={GROQ_MODEL_FAST} chat")
        full_response = groq_chat(messages, model=GROQ_MODEL_FAST, max_tokens=1024)
        conversation_history.append({"role": "assistant", "content": full_response})
        return {"content": full_response, "source": source_type, "context_chunks": len(relevant_chunks)}
    except Exception as e:
        err = f"Groq API error: {str(e)}"
        conversation_history.append({"role": "assistant", "content": err})
        return {"content": err, "source": "error"}


# ── File upload ────────────────────────────────────────────────────────────────

@app.post("/upload-file")
async def upload_file(file: UploadFile = File(...)):
    global file_chunks, file_embeddings, faiss_index, file_uploaded, uploaded_filename
    try:
        contents          = await file.read()
        text              = extract_text_from_file(contents, file.filename)
        if not text.strip():
            return {"error": "No text found in file"}
        file_chunks       = chunk_text(text)
        file_embeddings   = create_embeddings(file_chunks)
        faiss_index       = build_faiss_index(file_embeddings)
        file_uploaded     = True
        uploaded_filename = file.filename
        with open("file_chunks.pkl", "wb") as f:
            pickle.dump(file_chunks, f)
        faiss.write_index(faiss_index, "faiss_index.bin")
        return {"message": "File uploaded successfully", "chunks_count": len(file_chunks), "filename": file.filename}
    except Exception as e:
        return {"error": str(e)}


# ── Misc ───────────────────────────────────────────────────────────────────────

@app.get("/history")
def get_history():
    return {"history": conversation_history}

@app.post("/clear")
def clear_history():
    conversation_history.clear()
    return {"message": "History cleared"}

@app.post("/clear-file")
def clear_file():
    global file_chunks, file_embeddings, faiss_index, file_uploaded, uploaded_filename
    file_chunks = []; file_embeddings = None; faiss_index = None
    file_uploaded = False; uploaded_filename = ""
    for f in ["file_chunks.pkl", "file_embeddings.pkl", "faiss_index.bin"]:
        if os.path.exists(f): os.remove(f)
    return {"message": "File data cleared"}

@app.get("/file-status")
def file_status():
    return {
        "uploaded":     file_uploaded,
        "chunks_count": len(file_chunks) if file_uploaded else 0,
        "filename":     uploaded_filename if file_uploaded else None,
    }

@app.get("/health")
def health():
    return {
        "status":    "ok",
        "model_smart": GROQ_MODEL_SMART,
        "model_fast":  GROQ_MODEL_FAST,
        "cache": {
            "trending_age_seconds":  int(time.time() - _trending_cache["timestamp"]) if _trending_cache["data"] else None,
            "dashboard_age_seconds": int(time.time() - _dashboard_cache["timestamp"]) if _dashboard_cache["data"] else None,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)