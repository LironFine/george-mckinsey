import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Target, TrendingUp, Users, Zap, ShieldCheck, Layers, Clock } from 'lucide-react';
import { MODELS_INFO, STRATEGIC_TIPS } from '../constants';

export default function Sidebar({ onSelectModel, isMobile }: { onSelectModel: (modelName: string) => void, isMobile?: boolean }) {
  const [currentTip, setCurrentTip] = useState(STRATEGIC_TIPS[0]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTip(prev => {
        const currentIndex = STRATEGIC_TIPS.indexOf(prev);
        const nextIndex = (currentIndex + 1) % STRATEGIC_TIPS.length;
        return STRATEGIC_TIPS[nextIndex];
      });
    }, 10000); // Change tip every 10 seconds

    return () => clearInterval(interval);
  }, []);

  const models = [
    { icon: <Target size={18} />, name: 'OGSM', description: MODELS_INFO.OGSM },
    { icon: <TrendingUp size={18} />, name: 'Value Ladder', description: MODELS_INFO.VALUE_LADDER },
    { icon: <Users size={18} />, name: 'Audience', description: MODELS_INFO.AUDIENCE_OFFER_HOOK_CHANNEL },
    { icon: <Zap size={18} />, name: 'Pain/Promise', description: MODELS_INFO.PAIN_PROMISE_PROOF_PROPOSAL },
    { icon: <ShieldCheck size={18} />, name: 'SWOT', description: MODELS_INFO.SWOT },
    { icon: <Layers size={18} />, name: 'Before/After', description: MODELS_INFO.BEFORE_AFTER_BRIDGE },
    { icon: <Clock size={18} />, name: 'RTM', description: MODELS_INFO.RTM },
  ];

  return (
    <div className={`flex flex-col ${isMobile ? 'w-full h-full p-4 gap-4' : 'w-72 h-full gap-2'}`}>
      {!isMobile && (
        <div className="space-y-1 shrink-0 mb-1">
          <h2 className="text-lg font-bold text-slate-800">ארגז הכלים האסטרטגי</h2>
          <p className="text-[10px] text-slate-500">המודלים שאנחנו מיישמים לצמיחה</p>
        </div>
      )}

      <div className={`flex-1 space-y-1.5 ${isMobile ? 'overflow-y-auto pr-1' : 'overflow-hidden'}`}>
        {models.map((model, index) => (
          <motion.button
            key={model.name}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
            onClick={() => onSelectModel(model.name)}
            className="w-full text-right p-2 bg-white rounded-xl border border-slate-100 shadow-sm hover:shadow-md hover:border-blue-300 hover:bg-blue-50/30 cursor-pointer transition-all group"
          >
            <div className="flex items-center gap-2 mb-0.5">
              <div className="p-1 bg-blue-50 text-blue-600 rounded-lg group-hover:bg-blue-600 group-hover:text-white transition-colors">
                {model.icon}
              </div>
              <h3 className="font-bold text-[11px] text-slate-800">{model.name}</h3>
            </div>
            <p className="text-[9px] text-slate-500 leading-tight line-clamp-2">{model.description}</p>
          </motion.button>
        ))}
      </div>

      <div className={`shrink-0 p-4 bg-blue-600 rounded-3xl text-white flex flex-col justify-center mt-auto shadow-lg ${isMobile ? 'min-h-[80px]' : 'min-h-[100px]'}`}>
        <h4 className="font-bold text-xs mb-1 text-blue-100">טיפ אסטרטגי:</h4>
        <motion.p 
          key={currentTip}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[11px] font-medium leading-snug"
        >
          "{currentTip}"
        </motion.p>
      </div>
    </div>
  );
}
