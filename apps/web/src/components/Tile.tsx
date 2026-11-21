import { Link } from 'react-router-dom';

type TileProps = {
  label: string;
  value: number | string;
  /** Small line under the value. */
  meta?: string;
  metaClass?: 'ok' | 'bad' | 'warn';
  /** Makes the whole tile a link. */
  to?: string;
};

/** A figure tile (prototype UI.tile): label, big value, meta line; a link when `to` is given. */
export function Tile({ label, value, meta, metaClass, to }: TileProps) {
  const body = (
    <>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {meta ? <div className={metaClass ? `m ${metaClass}` : 'm'}>{meta}</div> : null}
    </>
  );
  return to ? (
    <Link to={to} className="tile">
      {body}
    </Link>
  ) : (
    <div className="tile">{body}</div>
  );
}
