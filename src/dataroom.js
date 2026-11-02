// Dropbox data rooms (Pierce, Nov 2 2026: "share view only links on data room for listings").
// One view-only folder link per listing, kept in listing.facts:
//   data_room_url     the Dropbox shared link (viewer access)
//   data_room_path    the folder it opens (display path), so the doc sync can watch what's inside
//   data_room_blocked files in that folder buyers must never see (set by the sync); while non-empty the link is not used
// A folder link has no gate of its own: anyone holding it sees the whole folder. So it goes ONLY to CA-verified buyers of
// that same listing, enforced in deliver() (rule 4: tiers live in code, not the prompt).

export const DATA_ROOM_KEYS = ['data_room_url', 'data_room_path', 'data_room_blocked'];

/** The listing's data room link, or null if it has none or the sync found files that must not be shared. */
export function dataRoomFor(listing) {
  const f = listing?.facts || {};
  return f.data_room_url && !(f.data_room_blocked?.length) ? f.data_room_url : null;
}

// Dropbox folder links: new style /scl/fo/<id>/<key>?rlkey=..., legacy /sh/<id>/<key>
const FOLDER_LINK = /https?:\/\/(?:www\.)?dropbox\.com\/(?:scl\/fo|sh)\/[^\s<>"')\]]+/gi;
const norm = (u) => String(u).split(/[?#]/)[0].replace(/[.,;:!]+$/, '').replace(/\/$/, '').toLowerCase();

/** null if the text may go out; otherwise why it has to wait for Pierce's Y. */
export function dataRoomProblem(text, lead, listing) {
  const links = String(text || '').match(FOLDER_LINK) || [];
  if (!links.length) return null;
  if (!lead?.ca_verified) return 'contains a Dropbox data room link, but the CA is not verified';
  const own = dataRoomFor(listing);
  if (!own) return 'contains a Dropbox folder link, but this listing has no cleared data room';
  if (links.some((u) => norm(u) !== norm(own))) return "contains a Dropbox folder link that is not this listing's data room";
  return null;
}

/** Path of a file inside the data room folder, or null if the file is not in it. */
export function inDataRoom(listing, pathDisplay) {
  const root = listing?.facts?.data_room_path;
  if (!root) return null;
  const r = root.replace(/\/$/, '').toLowerCase();
  const p = String(pathDisplay || '').toLowerCase();
  return p.startsWith(r + '/') ? pathDisplay.slice(r.length + 1) : null;
}
