interface PopupWindowProps {
  isOpen: boolean;
  onClose: () => void;
  content: string;
}

export default function PopupWindow({ isOpen, onClose, content }: PopupWindowProps) {
  const handleExportPDF = () => {
    const element = document.getElementById('generatedContent');
    if (element) {
      // @ts-ignore
      html2pdf()
        .set({
          margin: 1,
          filename: 'travel-itinerary.pdf',
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2 },
          jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
        })
        .from(element)
        .save();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 overflow-auto">
      <div className="relative bg-white mx-auto mt-[10%] p-8 w-[90%] md:w-2/3 lg:w-1/2 max-h-[80vh] overflow-y-auto rounded-lg shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-500 text-2xl font-bold hover:text-black transition-colors duration-200"
        >
          &times;
        </button>
        <div
          id="generatedContent"
          className="prose prose-lg max-w-none font-raleway"
          dangerouslySetInnerHTML={{ __html: content }}
        />
        <button
          onClick={handleExportPDF}
          className="w-full md:w-[40%] mx-auto my-6 px-6 py-3 bg-[#4798cc] text-white font-semibold text-lg rounded-xl hover:bg-[#3a7dc9] transition-colors duration-200 block"
        >
          Export as PDF
        </button>
      </div>
    </div>
  );
}
