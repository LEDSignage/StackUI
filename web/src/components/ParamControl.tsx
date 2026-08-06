import { useId, useState } from 'react';
import type { Param } from '@shared/types.ts';
import { uploadImage } from '../lib/comfy.ts';

const VIDEO_FILE = /\.(mp4|webm|mov|mkv)$/i;

type Props = {
  param: Param;
  value: unknown;
  onChange: (value: unknown) => void;
};

export function ParamControl({ param, value, onChange }: Props) {
  const v = value ?? param.default;

  return (
    <label className="param">
      <span className="param-label">{param.label}</span>
      {renderControl(param, v, onChange)}
    </label>
  );
}

function renderControl(param: Param, v: unknown, onChange: (value: unknown) => void) {
  switch (param.type) {
    case 'BOOLEAN':
      return (
        <input
          type="checkbox"
          className="param-check"
          checked={Boolean(v)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );

    case 'ENUM':
      return (
        <select className="param-input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(param.options ?? []).length === 0 && <option value={String(v ?? '')}>{String(v ?? '—')}</option>}
          {(param.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );

    case 'INT':
    case 'FLOAT':
      return (
        <input
          type="number"
          className="param-input"
          value={v === undefined || v === null ? '' : Number(v)}
          min={param.min}
          max={param.max}
          step={param.step ?? (param.type === 'INT' ? 1 : 0.01)}
          onChange={(e) => {
            const n = param.type === 'INT' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
            onChange(Number.isNaN(n) ? param.default : n);
          }}
        />
      );

    case 'IMAGE_UPLOAD':
      return <ImageUpload value={String(v ?? '')} onChange={onChange} />;

    case 'STRING':
    default:
      return param.multiline ? (
        // Two rows, resizable. A negative prompt is half a dozen words; giving
        // it a box the size of a paragraph just wastes the screen.
        <textarea
          className="param-input param-textarea"
          rows={2}
          value={String(v ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="param-input"
          value={String(v ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/**
 * A drop zone that POSTs to /upload/image and stores the returned `name` —
 * which is exactly what a LoadImage widget wants. Spec §3.
 *
 * It shows the picture. Storing a filename and displaying only that filename
 * tells you nothing about whether you loaded the right image.
 */
function ImageUpload({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unique per control. This used to be derived from the value, so every empty
  // slot on the page shared the id "up-new" — and a label activates the first
  // input with a matching id, so clicking the third reference opened the picker
  // for the first one and the file landed in the wrong slot.
  const inputId = useId();

  // Uploads land in ComfyUI's input folder, so that is where to read them back.
  const preview = value
    ? `/comfy/view?filename=${encodeURIComponent(value)}&subfolder=&type=input`
    : null;

  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadImage(file);
      onChange(res.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`upload ${busy ? 'is-busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void send(e.dataTransfer.files[0]);
      }}
    >
      <input
        type="file"
        accept="image/*,video/*"
        id={inputId}
        hidden
        onChange={(e) => void send(e.target.files?.[0])}
      />
      <label htmlFor={inputId} className="upload-label">
        {preview ? (
          <>
            {/* A video and a still both go into the same port — ComfyUI treats a
                picture as a batch of one frame — so this control handles both
                and picks the element by extension. */}
            {VIDEO_FILE.test(value) ? (
              <video
                src={preview}
                className="upload-preview"
                muted
                loop
                playsInline
                controls
                preload="metadata"
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture
              />
            ) : (
              <img src={preview} alt={value} className="upload-preview" />
            )}
            <span className="upload-name mono">{value}</span>
          </>
        ) : (
          <span className="upload-empty">{busy ? 'Uploading…' : 'Drop a file, or click'}</span>
        )}
      </label>
      {error && <span className="upload-error">{error}</span>}
    </div>
  );
}
