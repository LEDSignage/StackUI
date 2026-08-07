import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A video with our own controls.
 *
 * Chrome's native control bar collapses into a "⋮" overflow menu as soon as the
 * element is narrow — at library-tile widths that leaves the menu and nothing
 * else, no play button and no scrubber, which reads as a stray popup sitting on
 * a broken player. `controlsList` cannot bring them back: it only removes
 * entries, and the collapsing is not configurable at all.
 *
 * So the native bar is off and this draws the buttons itself. They are the same
 * four at every size, because they are ours.
 */
export function VideoPlayer({ src, className }: { src: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  // Keep our state in step with the element, which can be driven from elsewhere
  // — the keyboard, or the browser pausing a background tab.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setTime(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onVolume = () => setMuted(el.muted);

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('volumechange', onVolume);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('volumechange', onVolume);
    };
  }, [src]);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = video.current;
    if (!el || !duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - box.left) / box.width) * duration;
  };

  const fullscreen = () => {
    const el = video.current;
    if (!el) return;
    // Element fullscreen, so the video fills the display rather than the tile.
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div className={`player ${playing ? 'is-playing' : ''} ${className ?? ''}`}>
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        loop
        className="player-video"
        onClick={toggle}
      />

      {/* Over the picture, bottom right, on hover — a bar underneath cost every
          tile 34px of height and still could not fit its own contents at tile
          width. The scrubber is the full width of the bottom edge, where it has
          the room to be worth dragging. */}
      <div className="player-track" onClick={seek} role="slider" aria-valuenow={Math.round(pct)}>
        <div className="player-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="player-bar">
        <button className="player-btn" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play />}
        </button>

        <span className="player-time mono">{clock(time)}</span>

        <button
          className="player-btn"
          onClick={() => {
            const el = video.current;
            if (el) el.muted = !el.muted;
          }}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <Muted /> : <Sound />}
        </button>

        <button className="player-btn" onClick={fullscreen} title="Full screen">
          <Expand />
        </button>
      </div>
    </div>
  );
}

/*
 * Drawn, not typed.
 *
 * These were ▶ ❚❚ 🔊 ⛶ to begin with, and they came out blank: Inter has no
 * glyph for any of them, and U+26F6 in particular is missing from the Windows
 * fallback fonts too, so the buttons rendered as empty boxes you could not see.
 * An icon that depends on which fonts are installed is not an icon.
 */
const icon = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'currentColor' } as const;

const Play = () => (
  <svg {...icon} aria-hidden>
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);

const Pause = () => (
  <svg {...icon} aria-hidden>
    <path d="M4 2.5h3.2v11H4zM8.8 2.5H12v11H8.8z" />
  </svg>
);

const Sound = () => (
  <svg {...icon} aria-hidden>
    <path d="M7 2.5 3.6 5.4H1.5v5.2h2.1L7 13.5z" />
    <path
      d="M9.6 5.2a3.6 3.6 0 0 1 0 5.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

const Muted = () => (
  <svg {...icon} aria-hidden>
    <path d="M7 2.5 3.6 5.4H1.5v5.2h2.1L7 13.5z" />
    <path
      d="M10 6l3.5 4M13.5 6 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

const Expand = () => (
  <svg {...icon} aria-hidden>
    <path d="M2 2h5v1.6H3.6V7H2zM9 2h5v5h-1.6V3.6H9zM2 9h1.6v3.4H7V14H2zM12.4 9H14v5H9v-1.6h3.4z" />
  </svg>
);

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
