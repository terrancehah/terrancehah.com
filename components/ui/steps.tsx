"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "@/utils/cn"

interface StepsProps {
  currentStep: number
  steps: {
    number: number
    title: string
    icon: React.ElementType
  }[]
}

export function Steps({ currentStep, steps }: StepsProps) {
  return (
    <div className="space-y-20 pl-2">
      {steps.map((step) => {
        const Icon = step.icon
        const isCompleted = currentStep > step.number
        const isCurrent = currentStep === step.number

        return (
          <div key={step.number} className="relative">
            {step.number !== steps.length && (
              <div
                className={cn(
                  "absolute left-4 top-8 h-[calc(100%+3rem)] w-px -translate-x-[0.5px]",
                  isCompleted ? "bg-sky-blue" : "bg-gray-200"
                )}
              />
            )}
            <div className="group relative flex items-start gap-4">
              <div
                className={cn(
                  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  isCompleted
                    ? "bg-sky-blue text-white"
                    : isCurrent
                    ? "border-2 border-sky-blue bg-white"
                    : "border-2 border-gray-200 bg-white"
                )}
              >
                {isCompleted ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Icon className={cn("h-4 w-4", isCurrent ? "text-sky-blue" : "text-gray-400")} />
                )}
              </div>
              <div className="flex h-full my-auto">
                <div
                  className={cn(
                    "font-medium",
                    isCompleted || isCurrent ? "text-primary" : "text-gray-500",
                  )}
                >
                  {step.title}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
