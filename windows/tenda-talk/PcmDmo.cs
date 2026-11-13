using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class CameraSdkPcmDmo  {
    [ComVisible(true),Guid("D8AD0F58-5494-4102-97C5-EC798E59BCF4"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IMediaObject  {
        [PreserveSig]int GetStreamCount(IntPtr inputs,IntPtr outputs);
        [PreserveSig]int GetInputStreamInfo(uint index,IntPtr flags);
        [PreserveSig]int GetOutputStreamInfo(uint index,IntPtr flags);
        [PreserveSig]int GetInputType(uint index,uint type,IntPtr media);
        [PreserveSig]int GetOutputType(uint index,uint type,IntPtr media);
        [PreserveSig]int SetInputType(uint index,IntPtr media,uint flags);
        [PreserveSig]int SetOutputType(uint index,IntPtr media,uint flags);
        [PreserveSig]int GetInputCurrentType(uint index,IntPtr media);
        [PreserveSig]int GetOutputCurrentType(uint index,IntPtr media);
        [PreserveSig]int GetInputSizeInfo(uint index,IntPtr size,IntPtr lookahead,IntPtr alignment);
        [PreserveSig]int GetOutputSizeInfo(uint index,IntPtr size,IntPtr alignment);
        [PreserveSig]int GetInputMaxLatency(uint index,IntPtr latency);
        [PreserveSig]int SetInputMaxLatency(uint index,long latency);
        [PreserveSig]int Flush();
        [PreserveSig]int Discontinuity(uint index);
        [PreserveSig]int AllocateStreamingResources();
        [PreserveSig]int FreeStreamingResources();
        [PreserveSig]int GetInputStatus(uint index,IntPtr flags);
        [PreserveSig]int ProcessInput(uint index,IntPtr buffer,uint flags,long time,long duration);
        [PreserveSig]int ProcessOutput(uint flags,uint count,IntPtr buffers,IntPtr status);
        [PreserveSig]int Lock(int locked);
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]delegate int BufferData(IntPtr self,out IntPtr data,out uint length);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]delegate int BufferMax(IntPtr self,out uint length);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]delegate int BufferLength(IntPtr self,uint length);
    static void Put(IntPtr p,int value) {
        if(p!=IntPtr.Zero)Marshal.WriteInt32(p,value);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)]public class Source:IMediaObject,CameraSdkPcmSource.IProperties  {
        long next;
        long sample;
        byte[] silence=new byte[320];
        public int GetStreamCount(IntPtr inputs,IntPtr outputs) {
            Put(inputs,0);
            Put(outputs,1);
            return 0;
        }
        public int GetInputStreamInfo(uint index,IntPtr flags) {
            Put(flags,0);
            return 0;
        }
        public int GetOutputStreamInfo(uint index,IntPtr flags) {
            Put(flags,0);
            return 0;
        }
        public int GetInputType(uint index,uint type,IntPtr media) {
            return unchecked((int)0x80040206);
        }
        public int GetOutputType(uint index,uint type,IntPtr media) {
            return unchecked((int)0x80040206);
        }
        public int SetInputType(uint index,IntPtr media,uint flags) {
            return 0;
        }
        public int SetOutputType(uint index,IntPtr media,uint flags) {
            if(media==IntPtr.Zero)return 0;
            IntPtr fmt=Marshal.ReadIntPtr(media,80);
            if(fmt==IntPtr.Zero||Marshal.ReadInt32(media,72)<18||Marshal.ReadInt16(fmt,0)!=1||Marshal.ReadInt16(fmt,2)!=1||Marshal.ReadInt32(fmt,4)!=8000||Marshal.ReadInt16(fmt,14)!=16)return unchecked((int)0x80040205);
            return 0;
        }
        public int GetInputCurrentType(uint index,IntPtr media) {
            return unchecked((int)0x80004001);
        }
        public int GetOutputCurrentType(uint index,IntPtr media) {
            return unchecked((int)0x80004001);
        }
        public int GetInputSizeInfo(uint index,IntPtr size,IntPtr lookahead,IntPtr alignment) {
            Put(size,320);
            Put(lookahead,0);
            Put(alignment,1);
            return 0;
        }
        public int GetOutputSizeInfo(uint index,IntPtr size,IntPtr alignment) {
            Put(size,320);
            Put(alignment,1);
            return 0;
        }
        public int GetInputMaxLatency(uint index,IntPtr latency) {
            if(latency!=IntPtr.Zero)Marshal.WriteInt64(latency,0);
            return 0;
        }
        public int SetInputMaxLatency(uint index,long latency) {
            return 0;
        }
        public int Flush() {
            next=0;
            return 0;
        }
        public int Discontinuity(uint index) {
            return 0;
        }
        public int AllocateStreamingResources() {
            return 0;
        }
        public int FreeStreamingResources() {
            return 0;
        }
        public int GetInputStatus(uint index,IntPtr flags) {
            Put(flags,0);
            return 0;
        }
        public int ProcessInput(uint index,IntPtr buffer,uint flags,long time,long duration) {
            return unchecked((int)0x80004001);
        }
        public int ProcessOutput(uint flags,uint count,IntPtr buffers,IntPtr status) {
            Put(status,0);
            if(count!=1||buffers==IntPtr.Zero)return unchecked((int)0x80070057);
            IntPtr buffer=Marshal.ReadIntPtr(buffers);
            IntPtr vt=Marshal.ReadIntPtr(buffer);
            BufferLength set=(BufferLength)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt,24),typeof(BufferLength));
            long now=Stopwatch.GetTimestamp();
            if(next==0)next=now;
            if(now<next) {
                set(buffer,0);
                Marshal.WriteInt32(buffers,8,0);
                return 1;
            }
            BufferMax max=(BufferMax)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt,32),typeof(BufferMax));
            uint capacity;
            if(max(buffer,out capacity)!=0||capacity<320)return unchecked((int)0x80070057);
            BufferData get=(BufferData)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt,40),typeof(BufferData));
            IntPtr data;
            uint len;
            if(get(buffer,out data,out len)!=0||data==IntPtr.Zero)return unchecked((int)0x80070057);
            Marshal.Copy(silence,0,data,320);
            set(buffer,320);
            Marshal.WriteInt32(buffers,8,0);
            Marshal.WriteInt64(buffers,16,sample*1250);
            Marshal.WriteInt64(buffers,24,200000);
            sample+=160;
            // Keep an absolute sample clock: delayed Windows polls must not
            // stretch every 20 ms frame and slowly fill the web audio queue.
            next+=Stopwatch.Frequency/50;
            if(next<now-Stopwatch.Frequency/10)next=now+Stopwatch.Frequency/50;
            return 0;
        }
        public int Lock(int locked) {
            return 0;
        }
        public int GetCount(out uint count) {
            count=0;
            return 0;
        }
        public int GetAt(uint index,out CameraSdkPcmSource.PropertyKey key) {
            key=new CameraSdkPcmSource.PropertyKey();
            return unchecked((int)0x80070057);
        }
        public int GetValue(ref CameraSdkPcmSource.PropertyKey key,IntPtr value) {
            Marshal.Copy(new byte[24],0,value,24);
            Marshal.WriteInt16(value,19);
            return 0;
        }
        public int SetValue(ref CameraSdkPcmSource.PropertyKey key,IntPtr value) {
            return 0;
        }
        public int Commit() {
            return 0;
        }
    }
}
