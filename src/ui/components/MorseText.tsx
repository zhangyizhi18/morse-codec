import { useMemo } from 'react';

/**
 * 摩斯点划串渲染器。
 *
 * 字符以 / 分隔，词以 | 分隔。
 * 点用青色、划用橙色，便于肉眼读码。
 */
export function MorseText({ morse }: { morse: string }) {
  const parts = useMemo(() => {
    if (!morse) return null;
    return morse.split('|').map((word) =>
      word
        .split('/')
        .filter((c) => c.length > 0)
        .map((code) => (
          <span key={code + Math.random()}>
            {[...code].map((ch, i) => (
              <span key={i} className={ch === '.' ? 'dot' : 'dash'}>
                {ch}
              </span>
            ))}
          </span>
        )),
    );
  }, [morse]);

  if (!parts) return <div className="out empty">—</div>;

  return (
    <div className="out">
      {parts.map((chars, wi) => (
        <span key={wi}>
          {chars.map((c, ci) => (
            <span key={ci}>
              {ci > 0 && <span className="sep">/</span>}
              {c}
            </span>
          ))}
          {wi < parts.length - 1 && <span className="grp"> | </span>}
        </span>
      ))}
    </div>
  );
}
