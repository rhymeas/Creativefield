/* The placeholder pictures and clips change with every page load, not on a timer: each load counts one further. */
function next(): number {
  try {
    const n = Number(localStorage.getItem("creativefield.turn") ?? "0") || 0;
    localStorage.setItem("creativefield.turn", String(n + 1));
    return n;
  } catch {
    return Math.floor(Math.random() * 1000);
  }
}
export const LOAD_TURN = next();
