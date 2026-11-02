import { AGENTS } from './agents.mjs';

const ALTERNATES = ['#e8c66a', '#8ab4f8', '#b3a3f7'];
export function nextSeatAccent(agent, seats) {
  const primary = AGENTS.find(item => item.id === agent)?.color || '#c8d2dc';
  const used = new Set(seats.map((seat, index) => seatAccent(seats, index)));
  return [primary, ...ALTERNATES].find(color => !used.has(color)) || primary;
}
export function seatAccent(seats, index) {
  const seat = seats[index];
  if (!seat) return '#c8d2dc';
  const duplicate = seats.slice(0, index).filter(other => other.agent === seat.agent).length;
  return seat.color || (duplicate ? ALTERNATES[(duplicate - 1) % ALTERNATES.length] : AGENTS.find(agent => agent.id === seat.agent)?.color) || '#c8d2dc';
}
export const accentColor = hex => `\x1b[38;2;${parseInt(hex.slice(1,3),16)};${parseInt(hex.slice(3,5),16)};${parseInt(hex.slice(5,7),16)}m`;
