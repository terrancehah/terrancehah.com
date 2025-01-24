import React from 'react';
import flatpickr from 'flatpickr';
import 'flatpickr/dist/flatpickr.min.css';

export interface DatePickerProps {
  dates?: { startDate: string; endDate: string };
  onUpdate?: (dates: { startDate: string; endDate: string }) => void;
  style?: React.CSSProperties;
}

export const DatePicker: React.FC<DatePickerProps> = ({ dates, onUpdate, style }) => {
  const dateInputRef = React.useRef<HTMLInputElement>(null);
  const [displayDates, setDisplayDates] = React.useState({
    startDate: '',
    endDate: ''
  });

  React.useEffect(() => {
    if (dates?.startDate && dates?.endDate) {
      setDisplayDates({
        startDate: dates.startDate,
        endDate: dates.endDate
      });
    }
  }, [dates]);

  React.useEffect(() => {
    if (dateInputRef.current) {
      const fp = flatpickr(dateInputRef.current, {
        mode: "range",
        dateFormat: "Y-m-d",
        defaultDate: [displayDates.startDate, displayDates.endDate].filter(Boolean),
        inline: true,
        minDate: "today",
        onChange: (selectedDates) => {
          if (selectedDates.length === 2) {
            const formatDate = (date: Date) => {
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              return `${year}-${month}-${day}`;
            };

            const newStartDate = formatDate(selectedDates[0]);
            const newEndDate = formatDate(selectedDates[1]);
            
            setDisplayDates({
              startDate: newStartDate,
              endDate: newEndDate
            });

            onUpdate?.({
              startDate: newStartDate,
              endDate: newEndDate
            });
          }
        }
      });

      return () => {
        fp.destroy();
      };
    }
  }, [dates, onUpdate, displayDates]);

  return (
    <div className="w-min mx-auto bg-white rounded-3xl border border-gray-100 shadow-md">
      <div className="w-min px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Travel Dates</h3>
        
        {/* Date display box */}
        <div className="mb-4 p-3 bg-gray-50 rounded-lg text-center font-raleway text-gray-700">
          {displayDates.startDate && displayDates.endDate ? (
            <>
              <span>{displayDates.startDate}</span>
              <span className="mx-2">→</span>
              <span>{displayDates.endDate}</span>
            </>
          ) : (
            <span>Select your travel dates</span>
          )}
        </div>

        <div className="flex justify-center">
          <input 
            ref={dateInputRef}
            type="text"
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
};
