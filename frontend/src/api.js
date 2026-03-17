import axios from "axios";

const BASE_URL = "http://localhost:5000";

const api = axios.create({
  baseURL: BASE_URL,
  headers: { "Content-Type": "application/json" },
});

export const fetchTrending = async (limit = 5) => {
  const res = await api.get(`/trending?limit=${limit}`);
  return res.data.topics ?? [];
};

export const fetchPulseDashboard = async () => {
  const res = await api.get("/pulse-dashboard");
  return res.data;
};

export const searchReddit = async (query, history = []) => {
  const res = await api.post("/search-reddit", { query, history });
  return res.data;
};

export const fetchSubreddit = async (subreddit, limit = 5) => {
  const res = await api.get(`/subreddit/${subreddit}?limit=${limit}`);
  return res.data;
};

export const fetchPostComments = async (subreddit, postId) => {
  const res = await api.get(`/post/${subreddit}/${postId}/comments`);
  return res.data;
};

export const sendChat = async (message) => {
  const res = await api.post("/chat", { message });
  return res.data;
};

export const uploadFile = async (file) => {
  const formData = new FormData();
  formData.append("file", file);
  const res = await axios.post(`${BASE_URL}/upload-file`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};

export const clearHistory = async () => {
  const res = await api.post("/clear");
  return res.data;
};

export const getFileStatus = async () => {
  const res = await api.get("/file-status");
  return res.data;
};

export const healthCheck = async () => {
  const res = await api.get("/health");
  return res.data;
};

export default api;