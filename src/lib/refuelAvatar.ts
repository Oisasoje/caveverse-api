/**
 * Modern, accessible avatar palette designed for high contrast with white text.
 * Curated to look vibrant, aesthetic, and distinct across user avatars.
 */
export const AVATAR_PALETTE = [
  "#6366F1", // Indigo
  "#EC4899", // Pink
  "#8B5CF6", // Purple
  "#3B82F6", // Blue
  "#10B981", // Emerald
  "#F59E0B", // Amber
  "#EF4444", // Red
  "#14B8A6", // Teal
  "#F97316", // Orange
  "#06B6D4", // Cyan
  "#84CC16", // Lime
  "#8A7D9A", // Muted Mauve (legacy default)
];

/**
 * Derives default 1-2 letter uppercase initials from user's full name or email.
 */
export function getInitials(name?: string | null, email?: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (email?.slice(0, 2) ?? "ME").toUpperCase();
}

/**
 * Deterministically computes an avatar color from a seed string (e.g. email, initials, or user ID).
 * This ensures the same user always gets the same vibrant avatar color consistently
 * across backend, frontend, push notifications, and emails without storing a hardcoded static color.
 */
export function getDeterministicAvatarColor(seed: string): string {
  if (!seed) return "#8A7D9A";

  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index];
}
