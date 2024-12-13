import * as React from "react"

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Card({ className, ...props }: CardProps) {
  return (
    <div
      className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className}`}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: CardProps) {
  return <div className={`flex flex-col space-y-1.5 pt-4 pb-2 px-6 ${className}`} {...props} />
}

export function CardTitle({ className, ...props }: CardProps) {
  return (
    <h3
      className={`text-lg text-gray-700 font-semibold leading-none tracking-tight ${className}`}
      {...props}
    />
  )
}

export function CardDescription({ className, ...props }: CardProps) {
  return (
    <p className={`text-md text-muted-foreground ${className}`} {...props} />
  )
}

export function CardContent({ className, ...props }: CardProps) {
  return <div className={`px-2 pt-0 ${className}`} {...props} />
}
