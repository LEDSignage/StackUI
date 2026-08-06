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
    <div className={`player ${className ?? ''}`}>
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        loop
        className="player-video"
        onClick={toggle}
      />

      <div className="player-bar">
        <button className="player-btn" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>

        {/* Click anywhere on the track to seek. */}
        <div className="player-track" onClick={seek} role="slider" aria-valuenow={Math.round(pct)}>
          <div className="player-fill" style={{ width: `${pct}%` }} />
        </div>

        <span className="player-time mono">
          {clock(time)} / {clock(duration)}
        </span>

        <button
          className="player-btn"
          onClick={() => {
            const el = video.current;
            if (el) el.muted = !el.muted;
          }}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🔊'}
        </button>

        <button className="player-btn" onClick={fullscreen} title="Full screen">
          ⛶
        </button>
      </div>
    </div>
  );
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
