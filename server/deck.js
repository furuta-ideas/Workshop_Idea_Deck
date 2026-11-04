// Older records contain only a compact list. Preserve physical slots when present.
export function deckSlots(team) {
  const slots = Array(5).fill(null),
    seen = new Set();
  (team.deckSlots || []).slice(0, 5).forEach((id, i) => {
    if (team.deck.includes(id) && !seen.has(id)) {
      slots[i] = id;
      seen.add(id);
    }
  });
  for (const id of team.deck)
    if (!seen.has(id)) {
      const empty = slots.indexOf(null);
      if (empty < 0) break;
      slots[empty] = id;
      seen.add(id);
    }
  return slots;
}
