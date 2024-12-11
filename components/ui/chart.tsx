import * as React from "react"

export interface ChartConfig {
  [key: string]: {
    label: string;
    color: string;
  };
}

export interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
}

export function ChartContainer({ config, className, children, ...props }: ChartContainerProps) {
  const cssVars = Object.entries(config).reduce((acc, [key, value]) => ({
    ...acc,
    [`--color-${key}`]: value.color,
  }), {});

  return (
    <div className={className} style={cssVars as React.CSSProperties} {...props}>
      {children}
    </div>
  )
}

export const ChartTooltip = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={`rounded-lg border bg-background p-2 shadow-sm ${className}`}
    {...props}
  />
))
