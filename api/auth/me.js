import { cors, requireAllowedUser } from '../_lib/auth.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  let user;
  try { user = requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  return res.status(200).json({ email: user.email });
}
