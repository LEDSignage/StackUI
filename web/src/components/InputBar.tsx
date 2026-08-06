import type { InputKind, InputList, ModuleLibrary, Stack } from '@shared/types.ts';
import { inputCount, inputList, inputTile, type InputRef } from '../lib/stackOps.ts';
import { ParamControl } from './ParamControl.tsx';

type Props = {
  spec: InputList;
  stack: Stack;
  library: ModuleLibrary;
  onParam: (tileId: string, param: string, value: unknown) => void;
  onAdd: (kind: InputKind) => void;
  onRemove: (group: string) => void;
};

/**
 * The input bar — every input this job takes, with an Add button per kind.
 *
 * Kinds are whatever the pipeline declares: a still frame, a video clip, an
 * audio track. Adding one appends real tiles (a loader, and whatever consumes
 * it), so this is the one part of the Use screen that changes the pipeline
 * rather than only its settings.
 */
export function InputBar({ spec, stack, library, onParam, onAdd, onRemove }: Props) {
  const inputs = inputList(stack);

  const paramOf = (ref: InputRef, index: number, name: string) => {
    const tile = inputTile(stack, ref, index);
    const param = tile ? library[tile.moduleId]?.params.find((p) => p.name === name) : undefined;
    return tile && param ? { tile, param } : null;
  };

  return (
    <section className="use-group">
      <h3 className="use-group-title">
        {spec.label}{' '}
        <span className="input-count">
          {inputs.length}
          {spec.maxTotal !== undefined ? ` / ${spec.maxTotal}` : ''}
        </span>
      </h3>

      <div className="input-bar">
        {inputs.map((ref, n) => {
          const kind = spec.kinds.find((k) => k.id === ref.kind);
          if (!kind) return null;
          const file = paramOf(ref, kind.file.index, kind.file.param);
          const pos = kind.position ? paramOf(ref, kind.position.index, kind.position.param) : null;

          return (
            <div className="input-slot" key={ref.group}>
              <div className="input-slot-head">
                <span className="input-slot-n">
                  {kind.label} {n + 1}
                </span>
                <button className="link danger" onClick={() => onRemove(ref.group)} title="Remove">
                  remove
                </button>
              </div>

              {file ? (
                <ParamControl
                  param={{ ...file.param, label: '' }}
                  value={file.tile.params[file.param.name]}
                  onChange={(v) => onParam(file.tile.id, file.param.name, v)}
                />
              ) : (
                <div className="panel-none">missing file slot</div>
              )}

              {pos && kind.position && (
                <label className="input-pos">
                  <span>{kind.position.label}</span>
                  <ParamControl
                    param={{ ...pos.param, label: '' }}
                    value={pos.tile.params[pos.param.name]}
                    onChange={(v) => onParam(pos.tile.id, pos.param.name, v)}
                  />
                </label>
              )}
            </div>
          );
        })}

        {spec.kinds.map((kind) => {
          const used = inputCount(stack, kind.id);
          // Two ceilings: this kind's own, and the total across all kinds.
          const atMax =
            (kind.max !== undefined && used >= kind.max) ||
            (spec.maxTotal !== undefined && inputs.length >= spec.maxTotal);
          return (
            <button
              className="input-add"
              key={kind.id}
              onClick={() => onAdd(kind)}
              disabled={atMax}
              title={
                atMax
                  ? spec.maxTotal !== undefined && inputs.length >= spec.maxTotal
                    ? `At most ${spec.maxTotal} files in total`
                    : `This model accepts at most ${kind.max} ${kind.label} inputs`
                  : `Add another ${kind.label}`
              }
            >
              <span className="input-add-plus">+</span>
              <span>
                {kind.label}
                {kind.max !== undefined && (
                  <span className="input-add-max">
                    {' '}
                    {used}/{kind.max}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {spec.note && <p className="panel-hint">{spec.note}</p>}
    </section>
  );
}
