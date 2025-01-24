import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { DollarSign, Euro, PoundSterling, CircleDollarSign } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const currencyIcons: Record<string, LucideIcon> = {
    USD: DollarSign,
    EUR: Euro,
    GBP: PoundSterling,
    CNY: CircleDollarSign,
    JPY: CircleDollarSign,
}

interface CurrencyListProps {
    baseCurrency: string
    amount: number
    currencyData: Record<string, { name: string; rate: number }>
}

export function CurrencyList({ baseCurrency, amount, currencyData }: CurrencyListProps) {
    const convertedAmounts = useMemo(() => {
        return Object.entries(currencyData).reduce((acc, [currency, data]) => {
            acc[currency] = amount * data.rate
            return acc
        }, {} as Record<string, number>)
    }, [amount, currencyData])

    return (
        <ul className="space-y-1">
            {Object.entries(currencyData).map(([currency, data]) => {
                const Icon = currencyIcons[currency] || DollarSign
                return (
                    <motion.li
                        key={currency}
                        className="flex items-center justify-between p-2 mt-0 rounded-lg hover:bg-gray-100 transition-colors"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <div className="flex items-center space-x-3">
                            <div className="p-1 bg-gray-100 rounded-full">
                                <Icon className="w-5 h-5 text-gray-600" />
                            </div>
                            <div>
                                <p className="font-semibold text-sm">{currency}</p>
                                <p className="text-xs text-gray-500">{data.name}</p>
                            </div>
                        </div>
                        <div className="text-right">
                            <motion.p
                                key={convertedAmounts[currency]}
                                className="font-semibold text-sm"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.2 }}
                            >
                                {convertedAmounts[currency].toFixed(2)}
                            </motion.p>
                            <p className="text-xs text-gray-500">
                                1 {baseCurrency} = {data.rate.toFixed(4)} {currency}
                            </p>
                        </div>
                    </motion.li>
                )
            })}
        </ul>
    )
}
