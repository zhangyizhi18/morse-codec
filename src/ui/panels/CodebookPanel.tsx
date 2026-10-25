import { useMemo, useState } from 'react';
import type { Codebook } from '@core/index';

interface Props {
  codebook: Codebook;
  onSelect: (id: string) => void;
}

/** 码表浏览器：查看每个字符对应的电码 */
export function CodebookPanel({ codebook, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const entries = useMemo(() => {
    const all = Object.entries(codebook.entries);
    if (!query.trim()) return all;
    const q = query.trim().toLowerCase();
    return all.filter(
      ([ch, code]) =>
        ch.toLowerCase().includes(q) || code.toLowerCase().includes(q),
    );
  }, [codebook, query]);

  const shown = showAll ? entries : entries.slice(0, 120);
  const isNumeric = codebook.system === 'telegraph';

  return (
    <div className="panels">
      <div>
        <div className="card">
          <div className="card-head">
            码表信息
            <span className="spacer" />
            <span className="hint">{codebook.id}</span>
          </div>

          <div className="meta-list">
            <div>
              名称: <b>{codebook.displayName ?? codebook.name}</b>
            </div>
            <div>
              体系:{' '}
              <b>
                {codebook.system === 'morse' ? '摩斯电码（点划符号）' : '数字电码'}
              </b>
            </div>
            <div>
              收录字符: <b>{Object.keys(codebook.entries).length.toLocaleString()}</b>
            </div>
            <div>
              编码体系: <b>{codebook.system === 'morse' ? 'ITU-R M.1677-1' : '中文/商业电码'}</b>
            </div>
            {codebook.source && (
              <div>
                来源: <b style={{ fontSize: 11 }}>{codebook.source}</b>
              </div>
            )}
            {codebook.license && (
              <div>
                授权: <b>{codebook.license}</b>
              </div>
            )}
          </div>

          <div className="btn-row">
            <button className="btn sm" onClick={() => onSelect(codebook.id)}>
              使用此码表
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">查找字符</div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入字符或电码…"
            spellCheck={false}
          />
          <div className="stats">
            <span>
              匹配 <b>{entries.length.toLocaleString()}</b>
            </span>
          </div>
        </div>
      </div>

      <div>
        <div className="card">
          <div className="card-head">
            字符 → 电码
            <span className="spacer" />
            <span className="hint">
              {entries.length > 120 && !showAll
                ? `显示前 120 / ${entries.length}`
                : `${entries.length} 条`}
            </span>
          </div>

          {entries.length === 0 ? (
            <div className="out empty">没有匹配的字符</div>
          ) : (
            <>
              <div className="cb-grid">
                {shown.map(([ch, code]) => (
                  <div className="cb-item" key={ch}>
                    <span className="ch">{ch}</span>
                    <span className={`code${isNumeric ? ' num' : ''}`}>{code}</span>
                  </div>
                ))}
              </div>
              {entries.length > 120 && (
                <div className="btn-row">
                  <button
                    className="btn sm"
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll ? '收起' : `显示全部 ${entries.length} 条`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
