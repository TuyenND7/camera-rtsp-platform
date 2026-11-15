const owners = new Set<symbol>();
let previousOverflow = '';

/** Modal/fullscreen lifetimes can overlap or clean up in either order. */
export function lockBodyScroll(): () => void {
  const body = document.body, owner = Symbol();
  if (!owners.size) { previousOverflow = body.style.overflow; body.style.overflow = 'hidden'; }
  owners.add(owner);
  return () => {
    if (!owners.delete(owner)) return;
    if (!owners.size) body.style.overflow = previousOverflow;
  };
}
