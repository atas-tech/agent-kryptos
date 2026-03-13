import { Fragment, type KeyboardEvent, type ReactNode } from "react";

interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyState: ReactNode;
  loading?: boolean;
  footer?: ReactNode;
  expandedRowKey?: string | null;
  renderExpandedRow?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyState,
  loading = false,
  footer,
  expandedRowKey,
  renderExpandedRow,
  onRowClick
}: DataTableProps<T>) {
  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T): void {
    if (!onRowClick) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick(row);
    }
  }

  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const isExpanded = expandedRowKey === key && renderExpandedRow;

              return (
                <Fragment key={key}>
                  <tr
                    className={onRowClick ? "data-table__row data-table__row--interactive" : "data-table__row"}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={(event) => handleKeyDown(event, row)}
                    tabIndex={onRowClick ? 0 : undefined}
                  >
                    {columns.map((column) => (
                      <td key={column.key}>{column.render(row)}</td>
                    ))}
                  </tr>
                  {isExpanded ? (
                    <tr className="data-table__expanded">
                      <td colSpan={columns.length}>{renderExpandedRow(row)}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && rows.length === 0 ? emptyState : null}
      {footer ? <div className="table-card__footer">{footer}</div> : null}
    </div>
  );
}
