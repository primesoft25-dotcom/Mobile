import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const CartContext = createContext(null)
export function CartProvider({ children }) {
  const [items, setItems] = useState(() => JSON.parse(localStorage.getItem('aurora-cart') || '[]'))
  useEffect(() => localStorage.setItem('aurora-cart', JSON.stringify(items)), [items])
  const value = useMemo(() => ({ items, count: items.reduce((sum, item) => sum + item.quantity, 0), total: items.reduce((sum, item) => sum + item.price * item.quantity, 0), add(product) { setItems((current) => { const found = current.find((item) => item.name === product.name); return found ? current.map((item) => item.name === product.name ? { ...item, quantity: item.quantity + 1 } : item) : [...current, { ...product, quantity: 1 }] }) }, change(name, delta) { setItems((current) => current.map((item) => item.name === name ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item).filter((item) => item.quantity > 0)) }, clear() { setItems([]) } }), [items])
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
// The hook intentionally lives beside its provider to keep cart state ownership explicit.
// eslint-disable-next-line react-refresh/only-export-components
export function useCart() { return useContext(CartContext) }
