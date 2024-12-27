import { useState, useEffect } from 'react'
import { AlertCircle } from 'lucide-react'
import { CurrencyConverterProps, CURRENCY_INFO } from '@/managers/types'
import { fetchExchangeRates, formatCurrencyAmount } from '@/utils/currency-utils'
import { CurrencyList } from './CurrencyList'

export function CurrencyConverter({ 
    baseCurrency, 
    baseAmount = 100,
    onAmountChange,
    defaultCurrencies = ['USD', 'EUR', 'GBP', 'CNY', 'JPY']
}: CurrencyConverterProps) {
    const [amount, setAmount] = useState<number>(baseAmount)
    const [rates, setRates] = useState<{ [key: string]: number }>({})
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [error, setError] = useState<string | null>(null)
    const [lastUpdated, setLastUpdated] = useState<Date>(new Date())

    // Fetch exchange rates when component mounts or base currency changes
    useEffect(() => {
        const loadRates = async () => {
            if (!baseCurrency) return; // Add early return if baseCurrency is undefined
            try {
                setIsLoading(true)
                setError(null)
                const ratesData = await fetchExchangeRates(baseCurrency)
                setRates(ratesData)
                setLastUpdated(new Date())
                setIsLoading(false)
            } catch (err) {
                setError('Failed to load exchange rates. Please try again later.')
                setIsLoading(false)
            }
        }

        loadRates()
    }, [baseCurrency])

    // Filter rates to only include default currencies
    const currencyData = Object.fromEntries(
        Object.entries(rates)
            .filter(([code]) => defaultCurrencies.includes(code))
            .map(([code, rate]) => [
                code,
                {
                    name: CURRENCY_INFO[code]?.name || code,
                    rate
                }
            ])
    )

    const handleAmountChange = (value: number) => {
        setAmount(value)
        onAmountChange?.(value)
    }

    return (
        <div className="w-[80%] max-w-lg mx-auto bg-white rounded-3xl shadow-md border border-gray-100">
            {/* <div className="p-2 border-b border-gray-200">
                <h2 className="text-lg font-bold text-center">Currency Converter</h2>
                <p className="text-sm text-gray-500 text-center">
                    as of {lastUpdated.toLocaleDateString()}
                </p>
            </div> */}
            <div className="p-4">
                <div className="space-y-4">
                    <div className="flex flex-col items-center text-left w-full">
                        <label htmlFor="baseAmount" className="block text-lg font-semibold text-gray-700 self-start w-[95%] ml-5 mx-auto">
                            Currency Rates of {baseCurrency || 'USD'} - {CURRENCY_INFO[baseCurrency || 'USD']?.name || baseCurrency || 'USD'}
                        </label>
                        <p className="text-sm text-gray-500 text-left w-full px-5">
                            as of {lastUpdated.toLocaleDateString()}
                        </p>
                        <input
                            id="baseAmount"
                            type="number"
                            value={amount}
                            onChange={(e) => handleAmountChange(parseFloat(e.target.value) || 0)}
                            className="w-[95%] mt-1 px-3 py-2 text-lg mx-auto font-bold border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="Enter amount"
                        />
                    </div>
                    {error ? (
                        <div className="flex items-center space-x-2 text-red-500">
                            <AlertCircle size={20} />
                            <p>{error}</p>
                        </div>
                    ) : isLoading ? (
                        <div className="space-y-2">
                            {[1, 2, 3].map((i) => (
                                <div 
                                    key={i}
                                    className="h-10 w-full bg-gray-200 animate-pulse rounded-md"
                                />
                            ))}
                        </div>
                    ) : (
                        <CurrencyList
                            baseCurrency={baseCurrency || 'USD'} // Provide default value
                            amount={amount}
                            currencyData={currencyData}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}
