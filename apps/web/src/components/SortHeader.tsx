type SortHeaderProps<C extends string> = {
  label: string;
  column: C;
  sort: C;
  dir: 'asc' | 'desc';
  onSort: (column: C) => void;
};

/** A sortable column header: `<th aria-sort>` holding a button; the list decides the new direction. */
export function SortHeader<C extends string>({ label, column, sort, dir, onSort }: SortHeaderProps<C>) {
  const active = sort === column;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort(column)}>
        {label}
        <span aria-hidden="true" className={active ? 'arrow on' : 'arrow'}>
          {active && dir === 'desc' ? '↓' : '↑'}
        </span>
      </button>
    </th>
  );
}
