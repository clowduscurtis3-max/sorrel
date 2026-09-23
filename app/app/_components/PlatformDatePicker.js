import { Platform } from 'react-native';
import NativeDateTimePicker from '@react-native-community/datetimepicker';

// @react-native-community/datetimepicker has no web implementation - it
// renders nothing and logs "DateTimePicker is not supported on: web"
// instead of crashing, which silently broke every date editor in this app
// on web (Goal target date, recurring-charge next-expected-date). A plain
// <input type="date"> is the real, standard web equivalent and needs no
// native dependency - matches this component's exact value/mode/
// minimumDate/onChange(event, selectedDate) contract so every existing
// call site (GoalForm.js, (tabs)/goal.js, recurring-manage.js) works
// unchanged on both platforms.
function toInputValue(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function PlatformDatePicker({ value, mode, minimumDate, onChange }) {
  if (Platform.OS === 'web') {
    return (
      <input
        type="date"
        value={toInputValue(value)}
        min={minimumDate ? toInputValue(minimumDate) : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          if (!raw) {
            onChange({ type: 'dismissed' }, undefined);
            return;
          }
          const [y, m, d] = raw.split('-').map(Number);
          onChange({ type: 'set' }, new Date(y, m - 1, d));
        }}
        style={webInputStyle}
      />
    );
  }

  return (
    <NativeDateTimePicker value={value} mode={mode} minimumDate={minimumDate} onChange={onChange} />
  );
}

const webInputStyle = {
  fontSize: 16,
  padding: 10,
  borderRadius: 8,
  border: '1px solid #ccc',
  backgroundColor: '#fff',
  color: '#333',
};
