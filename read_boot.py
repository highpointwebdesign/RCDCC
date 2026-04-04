import serial, time
s = serial.Serial('COM5', 115200, timeout=0.1)
s.setDTR(False)
time.sleep(0.2)
s.setDTR(True)
buf = b''
end = time.time() + 6
while time.time() < end:
    chunk = s.read(1024)
    if chunk:
        buf += chunk
s.close()
text = buf.decode('utf-8', errors='replace')
print(text if text else '(no data received)')
