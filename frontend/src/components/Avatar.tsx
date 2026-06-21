// Avatar — Google profile picture, falls back to a gradient initial-circle.

interface Props {
  src?: string | null
  name?: string | null
  email?: string | null
  size?: number  // tailwind unit (e.g. 6 = w-6 h-6)
  className?: string
}

const SIZE_CLS: Record<number, string> = {
  6:  'w-6 h-6 text-[10px]',
  8:  'w-8 h-8 text-xs',
  10: 'w-10 h-10 text-sm',
  12: 'w-12 h-12 text-base',
  16: 'w-16 h-16 text-xl',
  20: 'w-20 h-20 text-2xl',
}

export function Avatar({ src, name, email, size = 8, className = '' }: Props) {
  const sizeCls = SIZE_CLS[size] ?? SIZE_CLS[8]

  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        className={`${sizeCls} rounded-full object-cover flex-shrink-0 ${className}`}
      />
    )
  }
  const initial = (name || email || '?').trim().charAt(0).toUpperCase()
  return (
    <div
      className={`${sizeCls} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 ${className}`}
      style={{
        background: 'linear-gradient(135deg, #3b82f6 0%, #818cf8 50%, #c084fc 100%)',
      }}
      aria-hidden
    >
      {initial}
    </div>
  )
}
