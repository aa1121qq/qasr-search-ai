import { useState, useRef, useEffect } from 'react'

export default function ImageCropper({ imageSrc, onConfirm, onCancel }) {
  const containerRef = useRef(null)
  const imgRef = useRef(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0, naturalW: 0, naturalH: 0 })
  // crop expressed as % of the displayed image (0-1)
  const [crop, setCrop] = useState({ x: 0.15, y: 0.15, w: 0.70, h: 0.70 })
  const [drag, setDrag] = useState(null)

  useEffect(() => {
    const onResize = () => {
      if (imgRef.current && imgRef.current.complete) {
        setImgSize({
          w: imgRef.current.clientWidth,
          h: imgRef.current.clientHeight,
          naturalW: imgRef.current.naturalWidth,
          naturalH: imgRef.current.naturalHeight,
        })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onImageLoad = (e) => {
    setImgSize({
      w: e.target.clientWidth,
      h: e.target.clientHeight,
      naturalW: e.target.naturalWidth,
      naturalH: e.target.naturalHeight,
    })
  }

  const getPoint = (e) => {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
    return { x: e.clientX, y: e.clientY }
  }

  const onPointerDown = (mode) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    const pt = getPoint(e)
    setDrag({ mode, startPt: pt, startCrop: { ...crop } })
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e) => {
      const pt = getPoint(e)
      const dxPx = pt.x - drag.startPt.x
      const dyPx = pt.y - drag.startPt.y
      const dx = imgSize.w > 0 ? dxPx / imgSize.w : 0
      const dy = imgSize.h > 0 ? dyPx / imgSize.h : 0

      let { x, y, w, h } = drag.startCrop
      const MIN = 0.10

      if (drag.mode === 'move') {
        x = Math.max(0, Math.min(1 - w, x + dx))
        y = Math.max(0, Math.min(1 - h, y + dy))
      } else {
        // resize handles: nw, ne, sw, se
        if (drag.mode.includes('e')) w = Math.max(MIN, Math.min(1 - x, w + dx))
        if (drag.mode.includes('s')) h = Math.max(MIN, Math.min(1 - y, h + dy))
        if (drag.mode.includes('w')) {
          const newX = Math.max(0, Math.min(x + w - MIN, x + dx))
          w = w + (x - newX)
          x = newX
        }
        if (drag.mode.includes('n')) {
          const newY = Math.max(0, Math.min(y + h - MIN, y + dy))
          h = h + (y - newY)
          y = newY
        }
      }
      setCrop({ x, y, w, h })
    }
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
    }
  }, [drag, imgSize])

  const handleConfirm = () => {
    if (!imgRef.current) return
    const canvas = document.createElement('canvas')
    const sx = crop.x * imgSize.naturalW
    const sy = crop.y * imgSize.naturalH
    const sw = crop.w * imgSize.naturalW
    const sh = crop.h * imgSize.naturalH
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgRef.current, sx, sy, sw, sh, 0, 0, sw, sh)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    onConfirm(dataUrl)
  }

  // overlay rectangle in pixel units relative to image
  const box = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  }

  return (
    <div className="cropper-overlay" onClick={onCancel}>
      <div className="cropper-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cropper-header">
          <h3>🎯 حدّد المنتج الرئيسي بالصورة</h3>
          <p>اسحب المربّع وغيّر حجمه ليحيط بالمنتج الذي تبحث عنه</p>
        </div>

        <div className="cropper-image-wrap" ref={containerRef}>
          <img
            ref={imgRef}
            src={imageSrc}
            alt="upload preview"
            onLoad={onImageLoad}
            draggable={false}
          />
          {imgSize.w > 0 && (
            <>
              {/* dark overlay outside the crop area */}
              <div className="cropper-shade" style={{ clipPath: `polygon(
                0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                ${crop.x * 100}% ${crop.y * 100}%,
                ${crop.x * 100}% ${(crop.y + crop.h) * 100}%,
                ${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%,
                ${(crop.x + crop.w) * 100}% ${crop.y * 100}%,
                ${crop.x * 100}% ${crop.y * 100}%
              )` }} />
              <div className="cropper-box" style={box} onMouseDown={onPointerDown('move')} onTouchStart={onPointerDown('move')}>
                <div className="cropper-handle nw" onMouseDown={onPointerDown('nw')} onTouchStart={onPointerDown('nw')} />
                <div className="cropper-handle ne" onMouseDown={onPointerDown('ne')} onTouchStart={onPointerDown('ne')} />
                <div className="cropper-handle sw" onMouseDown={onPointerDown('sw')} onTouchStart={onPointerDown('sw')} />
                <div className="cropper-handle se" onMouseDown={onPointerDown('se')} onTouchStart={onPointerDown('se')} />
                <div className="cropper-grid" />
              </div>
            </>
          )}
        </div>

        <div className="cropper-actions">
          <button className="cropper-btn cropper-cancel" onClick={onCancel}>إلغاء</button>
          <button className="cropper-btn cropper-confirm" onClick={handleConfirm}>🔍 بحث بالمنطقة المحددة</button>
        </div>
      </div>
    </div>
  )
}
